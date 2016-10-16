// Package config stores and exports the configuration for server-side use and
// the public availability JSON struct, which includes a small subset of the
// server configuration.
package config

import (
	"encoding/json"
	"sync"
	"time"

	"github.com/bakape/meguca/util"
)

var (
	// Ensures no reads happen, while the configuration is reloading
	globalMu, boardsMu, boardConfMu sync.RWMutex

	// Contains currently loaded global server configuration
	global *Configs

	// Array of currently existing boards
	boards []string

	// Map of board IDs to their cofiguration structs
	boardConfigs = map[string]BoardConfContainer{}

	// AllBoardConfigs stores board-specific configurations for the /all/
	// metaboard. Constant.
	AllBoardConfigs []byte

	// JSON of client-accessable configuration
	clientJSON []byte

	// Hash of the gloabal configs. Used for live reloading configuration on the
	// client.
	hash string

	// AllowedOrigin stores the accepted client origin for websocket and file
	// upload requests. Set only on server start.
	AllowedOrigin string

	// Defaults contains the default server configuration values
	Defaults = Configs{
		MaxThreads:    100,
		MaxBump:       1000,
		JPEGQuality:   80,
		PNGQuality:    20,
		MaxSize:       5,
		MaxHeight:     6000,
		MaxWidth:      6000,
		SessionExpiry: 30,
		Salt:          "LALALALALALALALALALALALALALALALALALALALA",
		FeedbackEmail: "admin@email.com",
		Public: Public{
			DefaultCSS:  "moe",
			FAQ:         defaultFAQ,
			DefaultLang: "en_GB",
			Links:       map[string]string{"4chan": "http://www.4chan.org/"},
		},
	}

	// EightballDefaults contains the default eightball answer set
	EightballDefaults = []string{
		"Yes",
		"No",
		"Maybe",
		"It can't be helped",
		"Hell yeah, motherfucker!",
		"Anta baka?",
	}
)

// Default string for the FAQ panel
const defaultFAQ = `Supported upload file types are JPEG, PNG, APNG, WEBM and MP3.
Encase words in ** to spoiler them. Spoilers reset on new line.
Boards that have not had any new posts in 7 days are automatically deleted.
<hr>Hash commands:
#d100 #2d100 - Roll dice
#flip - Coin flip
#8ball - An 8ball

All hash commands need to be input on their own line`

// Configs stores the global server configuration
type Configs struct {
	Public
	Prune             bool   `json:"prune" gorethink:"prune"`
	Pyu               bool   `json:"pyu" gorethink:"pyu"`
	MaxWidth          uint16 `json:"maxWidth" gorethink:"maxWidth"`
	MaxHeight         uint16 `json:"maxHeight" gorethink:"maxHeight"`
	MaxThreads        int    `json:"maxThreads" gorethink:"maxThreads"`
	MaxBump           int    `json:"maxBump" gorethink:"maxBump"`
	JPEGQuality       int
	PNGQuality        int
	MaxSize           int64         `json:"maxSize" gorethink:"maxSize"`
	Salt              string        `json:"salt" gorethink:"salt"`
	FeedbackEmail     string        `json:"feedbackEmail" gorethink:"feedbackEmail"`
	CaptchaPrivateKey string        `json:"captchaPrivateKey" gorethink:"captchaPrivateKey"`
	SessionExpiry     time.Duration `json:"sessionExpiry" gorethink:"sessionExpiry"`
}

// Public contains configurations exposable through public availability APIs
type Public struct {
	Radio            bool   `json:"radio" gorethink:"radio"`
	Hats             bool   `json:"hats" gorethink:"hats"`
	IllyaDance       bool   `json:"illyaDance" gorethink:"illyaDance"`
	Captcha          bool   `json:"captcha" gorethink:"captcha"`
	Mature           bool   `json:"mature" gorethink:"mature"`
	DefaultLang      string `json:"defaultLang" gorethink:"defaultLang"`
	DefaultCSS       string `json:"defaultCSS" gorethink:"defaultCSS"`
	CaptchaPublicKey string `json:"captchaPublicKey" gorethink:"captchaPublicKey"`
	FAQ              string
	Links            map[string]string `json:"links" gorethink:"links"`
}

// BoardConfigs stores board-specific configuration
type BoardConfigs struct {
	BoardPublic
	ID        string              `json:"id" gorethink:"id"`
	Eightball []string            `json:"eightball" gorethink:"eightball"`
	Staff     map[string][]string `json:"staff" gorethink:"staff"`
}

// BoardPublic contains publically accessable board-specific configurations
type BoardPublic struct {
	PostParseConfigs
	Spoilers bool     `json:"spoilers" gorethink:"spoilers"`
	CodeTags bool     `json:"codeTags" gorethink:"codeTags"`
	Spoiler  string   `json:"spoiler" gorethink:"spoiler"`
	Title    string   `json:"title" gorethink:"title"`
	Notice   string   `json:"notice" gorethink:"notice"`
	Rules    string   `json:"rules" gorethink:"rules"`
	Banners  []string `json:"banners" gorethink:"banners"`
}

// BoardConfContainer contains configurations for an individual board as well
// as pregenerated public JSON and it's hash
type BoardConfContainer struct {
	BoardConfigs
	JSON []byte
	Hash string
}

// DatabaseBoardConfigs contains extra fields not exposed on database reads
type DatabaseBoardConfigs struct {
	BoardConfigs
	Created time.Time `gorethink:"created"`
}

// PostParseConfigs contains board-specific flags for post text parsing
type PostParseConfigs struct {
	ReadOnly     bool `json:"readOnly" gorethink:"readOnly"`
	TextOnly     bool `json:"textOnly" gorethink:"textOnly"`
	ForcedAnon   bool `json:"forcedAnon" gorethink:"forcedAnon"`
	HashCommands bool `json:"hashCommands" gorethink:"hashCommands"`
}

// Generate /all/ board configs
func init() {
	conf := BoardPublic{
		PostParseConfigs: PostParseConfigs{
			HashCommands: true,
		},
		Spoilers: true,
		CodeTags: true,
		Spoiler:  "default.jpg",
		Title:    "Aggregator metaboard",
		Banners:  []string{},
	}

	var err error
	AllBoardConfigs, err = json.Marshal(conf)
	if err != nil {
		panic(err)
	}
}

// Get returns a pointer to the current server configuration struct. Callers
// should not modify this struct.
func Get() *Configs {
	globalMu.RLock()
	defer globalMu.RUnlock()
	return global
}

// Set sets the internal configuration struct. To be used only in tests.
func Set(c Configs) error {
	client, err := json.Marshal(c.Public)
	if err != nil {
		return err
	}
	h := util.HashBuffer(client)

	globalMu.Lock()
	clientJSON = client
	global = &c
	hash = h
	globalMu.Unlock()

	return nil
}

// GetClient returns punlic availability configuration JSON and a truncated
// configuration MD5 hash
func GetClient() ([]byte, string) {
	globalMu.RLock()
	defer globalMu.RUnlock()
	return clientJSON, hash
}

// SetClient sets the client configuration JSON and hash. To be used only in
// tests.
func SetClient(json []byte, cHash string) {
	globalMu.Lock()
	clientJSON = json
	hash = cHash
	globalMu.Unlock()
}

// SetBoards sets the slice of currently existing boards
func SetBoards(b []string) {
	boardsMu.Lock()
	boards = b
	boardsMu.Unlock()
}

// GetBoards returns the slice of currently existing boards
func GetBoards() []string {
	boardsMu.RLock()
	defer boardsMu.RUnlock()
	return boards
}

// GetBoardConfigs returns board-specific configurations for a board combined
// with pregenerated public JSON of these configurations and their hash
func GetBoardConfigs(b string) BoardConfContainer {
	boardConfMu.RLock()
	defer boardConfMu.RUnlock()
	return boardConfigs[b]
}

// SetBoardConfigs sets configurations for a specific board as well as
// pregenerates their public JSON and hash
func SetBoardConfigs(conf BoardConfigs) (err error) {
	cont := BoardConfContainer{
		BoardConfigs: conf,
	}
	cont.JSON, err = json.Marshal(conf.BoardPublic)
	if err != nil {
		return
	}
	cont.Hash = util.HashBuffer(cont.JSON)

	boardConfMu.Lock()
	boardConfigs[conf.ID] = cont
	boardConfMu.Unlock()

	return
}

// RemoveBoard removes a board from the exiting board list and deletes its
// configurations. To be called, when a board is deleted.
func RemoveBoard(b string) {
	boardConfMu.Lock()
	defer boardConfMu.Unlock()
	boardsMu.Lock()
	defer boardsMu.Unlock()

	delete(boardConfigs, b)
	for i, board := range boards {
		if board == b {
			boards = append(boards[:i], boards[i+1:]...)
		}
	}
}
