import cx from "classnames";
import { Component, h, render } from "preact";
import vmsg from "vmsg";
import { showAlert } from "../alerts";
import API from "../api";
import { isModerator } from "../auth";
import { PostData } from "../common";
import _ from "../lang";
import { boards, config, page, storeMine } from "../state";
import { duration, fileSize, renderBody } from "../templates";
import {
  AbortError,
  Dict,
  FutureAPI,
  getID,
  hook,
  HOOKS,
  on,
  printf,
  scrollToTop,
  setter as s,
  unhook,
} from "../util";
import {
  HEADER_HEIGHT_PX,
  POST_BODY_SEL,
  POST_SEL,
  REPLY_BOARD_WIDTH_PX,
  REPLY_CONTAINER_SEL,
  REPLY_HEIGHT_PX,
  REPLY_THREAD_WIDTH_PX,
  TRIGGER_OPEN_REPLY_SEL,
  TRIGGER_QUOTE_POST_SEL,
} from "../vars";
import { Progress } from "../widgets";
import { gen as genSign } from "./signature";
import SmileBox, { autocomplete } from "./smile-box";

function quoteText(text: string): string {
  return text
    .trim()
    .split(/\n/)
    .filter((line) => !!line)
    .map((line) => ">" + line)
    .join("\n");
}

function getVideoInfo(file: File | Blob): Promise<Dict> {
  return new Promise((resolve, reject) => {
    const vid = document.createElement("video");
    const src = URL.createObjectURL(file);
    vid.muted = true;
    vid.onloadeddata = () => {
      const { videoWidth: width, videoHeight: height, duration: dur } = vid;
      if (!width || !height) return reject(new Error("bad dimensions"));
      const c = document.createElement("canvas");
      const ctx = c.getContext("2d");
      c.width = width;
      c.height = height;
      ctx.drawImage(vid, 0, 0, width, height);
      const thumb = c.toDataURL();
      resolve({ width, height, dur, src, thumb });
    };
    vid.onerror = reject;
    vid.src = src;
    vid.play();
  });
}

function getAudioInfo(file: File | Blob): Promise<Dict> {
  return new Promise((resolve, reject) => {
    const audio = new Audio();
    const src = URL.createObjectURL(file);
    audio.muted = true;
    audio.onloadeddata = () => {
      const { duration: dur } = audio;
      resolve({ dur, src });
    };
    audio.onerror = reject;
    audio.src = src;
  });
}

function getImageInfo(file: File | Blob, skipCopy: boolean): Promise<Dict> {
  return new Promise((resolve, reject) => {
    const src = URL.createObjectURL(file);
    let thumb = src;
    const img = new Image();
    img.onload = () => {
      const { width, height } = img;
      if (skipCopy) {
        resolve({ width, height, src, thumb });
        return;
      }
      const c = document.createElement("canvas");
      const ctx = c.getContext("2d");
      c.width = width;
      c.height = height;
      ctx.drawImage(img, 0, 0, width, height);
      thumb = c.toDataURL();
      resolve({ width, height, src, thumb });
    };
    img.onerror = reject;
    img.src = src;
  });
}

function getFileInfo(file: File | Blob): Promise<Dict> {
  let fn = null;
  let skipCopy = false;
  if (file.type.startsWith("video/")) {
    fn = getVideoInfo;
  } else if (file.type === "audio/mpeg" || file.type === "audio/mp3") {
    fn = getAudioInfo;
  } else if (file.type.startsWith("image/")) {
    fn = getImageInfo;
    // TODO(Kagami): Dump first frame of APNG and animated WebP.
    if (file.type !== "image/gif") {
      skipCopy = true;
    }
  } else {
    fn = () => Promise.reject(new Error("Unsupported file type"));
  }
  return fn(file, skipCopy);
}

// Event helpers.
function getClientX(e: MouseEvent | TouchEvent): number {
  return (e as any).touches
    ? (e as any).touches[0].clientX
    : (e as any).clientX;
}
function getClientY(e: MouseEvent | TouchEvent): number {
  return (e as any).touches
    ? (e as any).touches[0].clientY
    : (e as any).clientY;
}

interface FilePreviewProps {
  info: Dict;
  file: File | Blob;
  onRemove: () => void;
}

class FilePreview extends Component<FilePreviewProps, {}> {
  public render(props: FilePreviewProps) {
    const record = props.file.type.startsWith("audio/");
    const { thumb } = props.info;
    const infoText = this.renderInfo();
    return (
      <div class="reply-file">
        <a class="control reply-remove-file-control" onClick={props.onRemove}>
          <i class="fa fa-remove" />
        </a>
        {record ? (
          <div class="reply-file-thumb reply-file-thumb_record">
            <i class="reply-file-thumb-icon fa fa-music" />
          </div>
        ) : (
          <img class="reply-file-thumb" src={thumb} />
        )}
        <div class="reply-file-info" title={infoText}>
          {infoText}
        </div>
      </div>
    );
  }
  private renderInfo(): string {
    const { size } = this.props.file;
    const { width, height, dur } = this.props.info;
    const chunks = [];
    if (width || height) {
      chunks.push(`${width}×${height}`);
    }
    chunks.push(fileSize(size));
    if (dur) {
      chunks.push(duration(Math.round(dur)));
    }
    return chunks.join(", ");
  }
}

class BodyPreview extends Component<any, any> {
  public shouldComponentUpdate({ body }: any) {
    return body !== this.props.body;
  }
  public render({ body }: any) {
    const post = { body } as PostData;
    const html = renderBody(post);
    return (
      <div
        class="reply-body reply-message"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }
}

interface FWrap {
  file: File | Blob;
  info: Dict;
}

type FWraps = FWrap[];

class Reply extends Component<any, any> {
  public state = {
    float: false,
    left: 0,
    top: 0,
    width: page.thread ? REPLY_THREAD_WIDTH_PX : REPLY_BOARD_WIDTH_PX,
    height: REPLY_HEIGHT_PX,
    pos: "i",
    editing: true,
    sending: false,
    progress: 0,
    board: page.board === "all" ? boards[0].id : page.board,
    thread: page.thread,
    subject: "",
    body: "",
    smileBox: false,
    smileBoxAC: null as string[],
    fwraps: [] as FWraps,
    showBadge: false,
  };
  private mainEl: HTMLElement = null;
  private bodyEl: HTMLTextAreaElement = null;
  private coverEl: HTMLElement = null;
  private fileEl: HTMLInputElement = null;
  private sendAPI: FutureAPI = {};
  private moving = false;
  private resizing = false;
  private baseX = 0;
  private baseY = 0;
  private startX = 0;
  private startY = 0;
  private startW = 0;
  private startH = 0;
  public componentWillMount() {
    const { quoted, dropped } = this.props;
    if (quoted) {
      this.quote(quoted);
      this.setFloat(quoted);
    }
    if (dropped) {
      this.handleDrop(dropped);
    }
  }
  public componentDidMount() {
    hook(HOOKS.openReply, this.focusAndScroll);
    hook(HOOKS.sendReply, this.handleSend);
    hook(HOOKS.selectFile, this.handleAttach);
    hook(HOOKS.previewPost, this.handleToggleEditing);
    hook(HOOKS.boldMarkup, this.pasteBold);
    hook(HOOKS.italicMarkup, this.pasteItalic);
    hook(HOOKS.spoilerMarkup, this.pasteSpoiler);
    document.addEventListener("mousemove", this.handleGlobalMove);
    document.addEventListener("touchmove", this.handleGlobalMove);
    document.addEventListener("mouseup", this.handleGlobalUp);
    document.addEventListener("touchend", this.handleGlobalUp);
    this.focusAndScroll();
    const caret = this.state.body.length;
    this.bodyEl.setSelectionRange(caret, caret);
  }
  public componentWillUnmount() {
    unhook(HOOKS.openReply, this.focusAndScroll);
    unhook(HOOKS.sendReply, this.handleSend);
    unhook(HOOKS.selectFile, this.handleAttach);
    unhook(HOOKS.previewPost, this.handleToggleEditing);
    unhook(HOOKS.boldMarkup, this.pasteBold);
    unhook(HOOKS.italicMarkup, this.pasteItalic);
    unhook(HOOKS.spoilerMarkup, this.pasteSpoiler);
    document.removeEventListener("mousemove", this.handleGlobalMove);
    document.removeEventListener("touchmove", this.handleGlobalMove);
    document.removeEventListener("mouseup", this.handleGlobalUp);
    document.removeEventListener("touchend", this.handleGlobalUp);
  }
  public componentWillReceiveProps({ quoted, dropped }: any) {
    if (quoted !== this.props.quoted) {
      if (quoted) {
        this.quote(quoted);
      } else {
        this.handleFormPin();
      }
    }
    if (dropped !== this.props.dropped) {
      if (dropped) {
        this.handleDrop(dropped);
      }
    }
  }
  public componentDidUpdate({}, { width, height }: any) {
    if (this.state.width !== width || this.state.height !== height) {
      this.setBodyScroll();
    }
  }
  public render({}, { float, fwraps, showBadge }: any) {
    const manyf = fwraps.length > 1;
    return (
      <div
        ref={s(this, "mainEl")}
        class={cx("reply", {
          reply_float: float,
          reply_files: manyf,
          reply_mod: showBadge,
        })}
        style={this.style}
        onMouseDown={this.handleFormDown}
        onMouseMove={this.handleFormMove}
      >
        <div class="reply-inner">
          <div class="reply-content">
            {this.renderFiles()}
            <div class="reply-content-inner">
              {this.renderHeader()}
              {this.renderBody()}
            </div>
          </div>

          {this.renderSideControls()}
        </div>

        {this.renderFooterControls()}
        {this.renderSmileBox()}

        <input
          class="reply-files-input"
          ref={s(this, "fileEl")}
          type="file"
          accept="image/*,video/*,audio/mpeg,audio/mp3"
          multiple
          onChange={this.handleFileChange}
        />
      </div>
    );
  }
  private get cursor() {
    switch (this.state.pos) {
      case "nw":
      case "se":
        return "nwse-resize";
      case "ne":
      case "sw":
        return "nesw-resize";
      case "n":
      case "s":
        return "ns-resize";
      case "e":
      case "w":
        return "ew-resize";
      default:
        return "inherit";
    }
  }
  private get minWidth() {
    return 400;
  }
  private get minHeight() {
    const manyf = this.state.fwraps.length > 1;
    return manyf ? 300 : 200;
  }
  private get style() {
    const { float, left, top, width } = this.state;
    // Recalc because it depends on state.
    const height = Math.max(this.minHeight, this.state.height);
    const o = { width, height, cursor: this.cursor } as Dict;
    if (float) {
      o.position = "fixed";
      o.left = left;
      o.top = top;
    }
    return o;
  }
  private get valid(): boolean {
    const { subject, body, fwraps } = this.state;
    const hasSubject = !!subject || !!page.thread;
    return hasSubject && !!(body || fwraps.length);
  }
  private get disabled() {
    const { sending } = this.state;
    return sending || !this.valid;
  }
  private quote(e: MouseEvent) {
    const post = (e.target as Element).closest(POST_SEL);
    const postBody = post.querySelector(POST_BODY_SEL);
    const postID = getID(post);
    let { body } = this.state;
    let start = 0;
    let end = 0;
    if (this.bodyEl) {
      start = this.bodyEl.selectionStart;
      end = this.bodyEl.selectionEnd;
    }

    let cited = "";
    const prevCh = start > 0 ? body[start - 1] : "";
    const prevNL = !prevCh || prevCh === "\n";
    const nextCh = end < body.length ? body[end] : "";
    const hasID = body.includes(">>" + postID);
    const sel = window.getSelection();
    const text = quoteText(sel.toString());
    const hasText =
      !sel.isCollapsed &&
      postBody.contains(sel.anchorNode) &&
      postBody.contains(sel.focusNode) &&
      !!text;

    if (hasText && !prevNL) {
      cited += "\n";
    }
    if (!hasText && !prevNL && prevCh !== " ") {
      cited += " ";
    }
    if (!hasText || !hasID) {
      cited += `>>${postID}`;
    }
    if (hasText && !hasID) {
      cited += "\n";
    }
    if (hasText) {
      cited += text;
    }
    if (hasText || prevNL) {
      cited += "\n";
    }

    const caret = start + cited.length;
    if (end < body.length) {
      if (hasText || prevNL) {
        if (nextCh !== "\n") {
          cited += "\n";
        }
      } else {
        if (nextCh !== " ") {
          cited += " ";
        }
      }
    }

    body = body.slice(0, start) + cited + body.slice(end);
    this.setState({ body }, () => {
      // Don't focus invisible element.
      if (this.bodyEl && this.bodyEl.offsetParent !== null) {
        this.focus();
        this.bodyEl.setSelectionRange(caret, caret);
      }
    });
  }
  private setFloat(e: MouseEvent) {
    const post = (e.target as Element).closest(POST_SEL);
    const rect = post.getBoundingClientRect();

    const margin = 10;
    const leftest = 0;
    const rightest = window.innerWidth - this.state.width - margin;
    const toppest = HEADER_HEIGHT_PX + margin;
    const bottomest = window.innerHeight - this.state.height - margin;
    const x = rect.right + margin;
    const y = rect.top;
    const left = Math.max(leftest, Math.min(x, rightest));
    const top = Math.max(toppest, Math.min(y, bottomest));

    this.setState({ float: true, left, top });
  }
  private focus = () => {
    if (this.bodyEl) {
      this.bodyEl.focus();
    }
  };
  private focusAndScroll = () => {
    this.focus();
    if (this.bodyEl) {
      if (page.thread) {
        if (!this.state.float) {
          this.bodyEl.scrollIntoView();
        }
      } else {
        scrollToTop();
      }
    }
  };
  private saveCoords(e: MouseEvent | TouchEvent) {
    this.baseX = getClientX(e);
    this.baseY = getClientY(e);
    const rect = this.mainEl.getBoundingClientRect();
    this.startX = rect.left;
    this.startY = rect.top;
    this.startW = rect.width;
    this.startH = rect.height;
  }
  private pasteMarkup(markup: string, opts?: Dict) {
    const { mono, nosep, offset } = opts || ({} as Dict);
    const start = this.bodyEl.selectionStart - (offset || 0);
    const end = this.bodyEl.selectionEnd;
    let { body } = this.state;
    if (start < end && !mono) {
      const sel = body.slice(start, end);
      body = body.slice(0, start) + markup + sel + markup + body.slice(end);
      this.setState({ body }, this.focus);
    } else {
      const prevCh = start > 0 ? body[start - 1] : "";
      const sep =
        !prevCh || prevCh === "\n" || prevCh === " " || nosep ? "" : " ";
      const sndMarkup = mono ? "" : markup;
      body = body.slice(0, start) + sep + markup + sndMarkup + body.slice(end);
      const caret = start + sep.length + markup.length;
      this.setState({ body }, () => {
        this.focus();
        this.bodyEl.setSelectionRange(caret, caret);
      });
    }
  }
  private pasteBold = () => this.pasteMarkup("**");
  private pasteItalic = () => this.pasteMarkup("*");
  private pasteSpoiler = () => this.pasteMarkup("%%");

  // tslint:disable-next-line:member-ordering
  private handleGlobalMove = ((e: MouseEvent | TouchEvent) => {
    if (this.moving) {
      this.setState({
        float: true,
        left: this.startX + getClientX(e) - this.baseX,
        top: this.startY + getClientY(e) - this.baseY,
      });
    } else if (this.resizing) {
      const { pos } = this.state;
      const dx = getClientX(e) - this.baseX;
      const dy = getClientY(e) - this.baseY;
      let { startW: width, startH: height, startX: left, startY: top } = this;
      switch (pos) {
        case "nw":
          left += dx;
          width -= dx;
          top += dy;
          height -= dy;
          break;
        case "se":
          width += dx;
          height += dy;
          break;
        case "ne":
          width += dx;
          top += dy;
          height -= dy;
          break;
        case "sw":
          left += dx;
          width -= dx;
          height += dy;
          break;
        case "n":
          top += dy;
          height -= dy;
          break;
        case "s":
          height += dy;
          break;
        case "e":
          width += dx;
          break;
        case "w":
          left += dx;
          width -= dx;
          break;
      }

      // Restore out-of-bound values.
      if (
        width < this.minWidth &&
        (pos === "nw" || pos === "sw" || pos === "w")
      ) {
        left -= this.minWidth - width;
      }
      if (
        height < this.minHeight &&
        (pos === "nw" || pos === "ne" || pos === "n")
      ) {
        top -= this.minHeight - height;
      }
      width = Math.max(width, this.minWidth);
      height = Math.max(height, this.minHeight);

      this.setState({ width, height, left, top });
    }
    // https://github.com/Microsoft/TypeScript/issues/22565
  }) as EventListenerOrEventListenerObject;
  private handleGlobalUp = () => {
    this.moving = false;
    this.resizing = false;
  };

  private handleMoveDown = (e: MouseEvent | TouchEvent) => {
    e.preventDefault();
    this.moving = true;
    this.saveCoords(e);
  };
  private handleFormDown = (e: MouseEvent) => {
    if (this.state.pos === "i") return;
    e.preventDefault();
    this.resizing = true;
    this.saveCoords(e);
  };
  private handleFormMove = (e: MouseEvent) => {
    if (this.resizing) return;
    const rect = this.mainEl.getBoundingClientRect();
    const w = rect.width;
    // tslint:disable-next-line:no-shadowed-variable
    const h = rect.height;
    const ox = e.clientX - rect.left;
    const oy = e.clientY - rect.top;
    const b = 5;
    let pos = "i";
    if (ox <= b && oy <= b) {
      pos = "nw";
    } else if (ox <= b && oy >= h - b) {
      pos = "sw";
    } else if (ox >= w - b && oy <= b) {
      pos = "ne";
    } else if (ox >= w - b && oy >= h - b) {
      pos = "se";
    } else if (ox <= b) {
      pos = "w";
    } else if (oy <= b) {
      pos = "n";
    } else if (ox >= w - b) {
      pos = "e";
    } else if (oy >= h - b) {
      pos = "s";
    }
    this.setState({ pos });
  };
  private handleFormPin = () => {
    this.setState({ float: false }, this.focus);
  };
  private handleFormHide = () => {
    this.props.onHide();
  };
  private handleSubjectChange = (e: any) => {
    this.setState({ subject: e.target.value });
  };
  private handleBoardChange = (e: any) => {
    this.setState({ board: e.target.value });
  };
  private setBodyScroll() {
    const hasScroll = this.bodyEl.scrollHeight > this.bodyEl.clientHeight;
    (this.bodyEl.parentNode as HTMLElement).classList.toggle(
      "reply-body_scrollable",
      hasScroll
    );
    const scrollWidth = this.bodyEl.offsetWidth - this.bodyEl.clientWidth;
    this.coverEl.style.width = scrollWidth + "px";
  }
  private handleBodyChange = (e: any) => {
    this.setBodyScroll();
    const smileBoxAC = autocomplete(this.bodyEl);
    const smileBox = !!smileBoxAC;
    this.setState({ body: e.target.value, smileBox, smileBoxAC });
  };
  private handleAttach = () => {
    this.fileEl.click();
  };
  private handleRecord = () => {
    let pitch = Math.random() * 2 - 1; // [-1, 1]
    if (pitch > -0.2 && pitch < 0.2) {
      // Don't tolerate zero pitch shift.
      pitch = 0.2;
    }
    // Have to accept Blob because Edge doesn't have File constructor...
    vmsg.record({ pitch }).then((blob) => {
      this.handleFiles([blob]);
    });
  };
  private handleAttachRemove = (src: string) => {
    if (this.state.sending) return;
    const fwraps = this.state.fwraps.filter((f) => f.info.src !== src);
    this.setState({ fwraps }, this.focus);
  };
  private handleDrop = (files: FileList) => {
    if (files.length) {
      this.handleFiles(files);
    }
  };
  private handleFileChange = () => {
    const files = this.fileEl.files;
    if (files.length) {
      this.handleFiles(files);
    }
    this.fileEl.value = null; // Allow to select same file again
  };
  private handleFiles = (files: FileList | Blob[]) => {
    // Limit number of selected files.
    const fslice: Array<File | Blob> = Array.prototype.slice.call(
      files,
      0,
      config.maxFiles
    );
    const fwrapsOld = this.state.fwraps;
    const fwrapsNew = Array(fslice.length);
    fslice.map(this.handleFile).forEach((p, i) =>
      p.then(
        (fwrap) => {
          // Append in order.
          fwrapsNew[i] = fwrap;
          let fwraps = fwrapsOld.concat(fwrapsNew.filter((f) => f != null));
          // Skip elder attachments.
          fwraps = fwraps.slice(Math.max(0, fwraps.length - config.maxFiles));
          this.setState({ fwraps }, this.focus);
        },
        (err) => {
          const errMsg = err.message ? `: ${err.message}` : "";
          showAlert(_("unsupFile") + errMsg);
        }
      )
    );
  };
  private handleFile = (file: File | Blob): Promise<FWrap> => {
    if (file.size > config.maxSize * 1024 * 1024) {
      return Promise.reject(new Error(_("tooBig")));
    }
    return getFileInfo(file).then((info: Dict) => ({ file, info }));
  };
  private handleSend = () => {
    if (this.disabled) return;
    const { board, thread, subject, body, showBadge } = this.state;
    const files = this.state.fwraps.map((f) => f.file);
    const sendFn = page.thread ? API.post.create : API.thread.create;
    this.setState({ sending: true });
    API.post
      .createToken()
      .then(({ id: token }: Dict) => {
        const sign = genSign(token);
        return sendFn(
          {
            board,
            thread,
            subject,
            body,
            files,
            showBadge,
            token,
            sign,
          },
          this.handleSendProgress,
          this.sendAPI
        );
      })
      .then(
        (res: Dict) => {
          if (page.thread) {
            storeMine(res.id, page.thread);
            this.handleFormHide();
          } else {
            storeMine(res.id, res.id);
            location.href = `/${board}/${res.id}`;
          }
        },
        (err: Error) => {
          if (err instanceof AbortError) return;
          showAlert({ title: _("sendErr"), message: err.message });
        }
      )
      .then(() => {
        this.setState({ sending: false, progress: 0 });
        this.sendAPI = {};
      });
  };
  private handleSendProgress = (e: ProgressEvent) => {
    const progress = Math.floor((e.loaded / e.total) * 100);
    this.setState({ progress });
  };
  private handleSendAbort = () => {
    if (this.sendAPI.abort) {
      this.sendAPI.abort();
    }
  };
  private handleToggleEditing = () => {
    const editing = !this.state.editing;
    this.setState({ editing, smileBox: false }, this.focus);
  };
  private handleToggleShowBadge = () => {
    const showBadge = !this.state.showBadge;
    this.setState({ showBadge }, this.focus);
  };
  private handleToggleSmileBox = (e: MouseEvent) => {
    // Needed because of https://github.com/developit/preact/issues/838
    e.stopPropagation();
    const smileBox = !!this.state.smileBoxAC || !this.state.smileBox;
    this.setState({ smileBox, smileBoxAC: null });
  };
  private handleHideSmileBox = () => {
    this.setState({ smileBox: false });
  };
  private handleSmileSelect = (id: string) => {
    this.setState({ smileBox: false });

    // Remove already typed smile chunk.
    const ac = !!this.state.smileBoxAC;
    let offset = 0;
    if (ac) {
      let i = this.bodyEl.selectionEnd - 1;
      while (i >= 0 && this.state.body[i] !== ":") {
        i--;
        offset++;
      }
      offset++;
    }

    this.pasteMarkup(`:${id}:`, { mono: true, nosep: ac, offset });
  };

  private renderBoards() {
    if (page.board !== "all") return null;
    const { sending, board } = this.state;
    return (
      <select
        class="reply-board"
        value={board}
        disabled={sending}
        onInput={this.handleBoardChange}
      >
        {boards.map(({ id }) => (
          <option class="reply-board-item" key={id} value={id}>
            {id}
          </option>
        ))}
      </select>
    );
  }
  private renderFiles() {
    const { fwraps } = this.state;
    return (
      <div class="reply-files">
        {fwraps.map(({ file, info }) => (
          <FilePreview
            key={info.src}
            info={info}
            file={file}
            onRemove={this.handleAttachRemove.bind(null, info.src)}
          />
        ))}
      </div>
    );
  }
  private renderHeader() {
    if (page.thread) return null;
    const { sending, subject } = this.state;
    return (
      <div class="reply-header">
        {this.renderBoards()}
        <input
          class="reply-subject"
          placeholder={_("subject") + "∗"}
          value={subject}
          disabled={sending}
          onInput={this.handleSubjectChange}
        />
      </div>
    );
  }
  private renderBody() {
    const { editing, sending, body } = this.state;
    return editing ? (
      <div class="reply-body">
        <textarea
          class="reply-body-inner"
          ref={s(this, "bodyEl")}
          value={body}
          disabled={sending}
          onInput={this.handleBodyChange}
        />
        <div class="reply-body-coverbar" ref={s(this, "coverEl")} />
      </div>
    ) : (
      <BodyPreview body={body} />
    );
  }
  private renderSideControls() {
    const { float, sending } = this.state;
    return (
      <div class="reply-controls reply-side-controls">
        <div class="reply-side-controls-inner">
          {float && (
            <a
              class="control reply-side-control reply-pin-control"
              onClick={this.handleFormPin}
            >
              <i class="fa fa-thumb-tack" />
            </a>
          )}
          <button
            class="control reply-side-control reply-hide-control"
            onClick={this.handleFormHide}
            disabled={sending}
          >
            <i class="fa fa-remove" />
          </button>
        </div>
        <div
          class="reply-dragger"
          onMouseDown={this.handleMoveDown}
          onTouchStart={this.handleMoveDown}
        />
      </div>
    );
  }
  private renderFooterControls() {
    const { editing, sending, progress, showBadge } = this.state;
    const sendTitle = sending ? `${progress}% (${_("clickToCancel")})` : "";
    return (
      <div class="reply-controls reply-footer-controls">
        <button
          class="control reply-footer-control reply-attach-control"
          title={printf(_("attach"), fileSize(config.maxSize * 1024 * 1024))}
          disabled={sending}
          onClick={this.handleAttach}
        >
          <i class="fa fa-file-image-o" />
        </button>
        <button
          class="control reply-footer-control reply-record-control"
          title={_("record")}
          disabled={sending}
          onClick={this.handleRecord}
        >
          <i class="fa fa-file-audio-o" />
        </button>

        <button
          class="control reply-footer-control reply-bold-control"
          title={_("bold")}
          disabled={!editing || sending}
          onClick={this.pasteBold}
        >
          <i class="fa fa-bold" />
        </button>
        <button
          class="control reply-footer-control reply-italic-control"
          title={_("italic")}
          disabled={!editing || sending}
          onClick={this.pasteItalic}
        >
          <i class="fa fa-italic" />
        </button>
        <button
          class="control reply-footer-control reply-spoiler-control"
          title={_("spoiler")}
          disabled={!editing || sending}
          onClick={this.pasteSpoiler}
        >
          <i class="fa fa-eye-slash" />
        </button>
        <button
          class="control reply-footer-control reply-smile-control"
          title={_("smile")}
          disabled={!editing || sending}
          onClick={this.handleToggleSmileBox}
        >
          <i class="reply-smile-icon" />
        </button>
        <button
          class="control reply-footer-control reply-edit-control"
          title={_("previewPost")}
          disabled={sending}
          onClick={this.handleToggleEditing}
        >
          <i class={cx("fa", editing ? "fa-print" : "fa-pencil")} />
        </button>
        {isModerator() && (
          <button
            class={cx(
              "control",
              "reply-footer-control",
              "reply-badge-control",
              { control_active: showBadge }
            )}
            title={_("staffBadge")}
            disabled={sending}
            onClick={this.handleToggleShowBadge}
          >
            <i class="fa fa-id-badge" />
          </button>
        )}

        <div
          class="reply-dragger"
          onMouseDown={this.handleMoveDown}
          onTouchStart={this.handleMoveDown}
        />
        {this.valid && (
          <Progress
            className="button reply-send-button"
            progress={progress}
            title={sendTitle}
            onClick={sending ? this.handleSendAbort : this.handleSend}
          >
            {sending ? "" : _("submit")}
          </Progress>
        )}
      </div>
    );
  }
  private renderSmileBox() {
    const { body, smileBox, smileBoxAC } = this.state;
    if (!smileBox) return null;
    return (
      <SmileBox
        body={body}
        acList={smileBoxAC}
        wrapper={this.mainEl}
        textarea={this.bodyEl}
        onSelect={this.handleSmileSelect}
        onClose={this.handleHideSmileBox}
      />
    );
  }
}

class ReplyContainer extends Component<any, any> {
  public state = {
    show: false,
    quoted: null as Element,
    dropped: null as FileList,
  };
  public componentDidMount() {
    hook(HOOKS.openReply, () => {
      this.setState({ show: true });
    });
    hook(HOOKS.closeReply, this.handleHide);

    on(
      document,
      "click",
      () => {
        this.setState({ show: true });
      },
      { selector: TRIGGER_OPEN_REPLY_SEL }
    );
    on(
      document,
      "click",
      (e) => {
        this.setState({ show: true, quoted: e });
      },
      { selector: TRIGGER_QUOTE_POST_SEL }
    );

    on(document, "dragover", (e) => {
      e.preventDefault();
    });
    on(document, "drop", (e: Event) => {
      e.preventDefault();
      const files = (e as DragEvent).dataTransfer.files;
      if (files.length) {
        this.setState({ show: true, dropped: files });
      }
    });
  }
  public render({}, { show, quoted, dropped }: any) {
    return show ? (
      <Reply quoted={quoted} dropped={dropped} onHide={this.handleHide} />
    ) : null;
  }
  private handleHide = () => {
    this.setState({ show: false, quoted: null, dropped: null });
  };
}

export function init() {
  const container = document.querySelector(REPLY_CONTAINER_SEL);
  if (container) {
    render(<ReplyContainer />, container);
  }
}
