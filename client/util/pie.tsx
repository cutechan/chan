/**
 * Pure CSS circular progress bar.
 * Based on <https://codepen.io/geedmo/pen/InFfd>.
 */

import * as cx from "classnames"
import { h } from "preact"

interface Props {
	progress: number,
	className?: string,
}

export default function({ progress, className }: Props): JSX.Element {
	const cls = cx("pie", `pie_progress${progress}`, className)
	return (
		<div class={cls} title={`${progress}%`}>
			<div class="pie-inner" />
		</div>
	)
}
