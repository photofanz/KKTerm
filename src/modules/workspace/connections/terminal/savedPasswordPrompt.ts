const PROMPT_WINDOW_MS = 30_000;
const PASSWORD_PROMPT = /(?:^|[\r\n])\s*(?:\[sudo\]\s*)?password(?:\s+for\s+[^:\r\n]+)?:\s*$/iu;

// Tab completion and readline kill/yank/transpose/undo/chord keys rewrite the
// remote line without echoing their text through onData.
const READLINE_EDIT_CHARACTERS = "\x1b\t\x01\x02\x05\x06\x0b\x0e\x10\x12\x14\x15\x17\x18\x19\x1f";

function visibleTerminalText(data: string) {
  let result = "";
  for (let index = 0; index < data.length; index += 1) {
    if (data.charCodeAt(index) !== 27) {
      result += data[index];
      continue;
    }
    const kind = data[index + 1];
    if (kind === "[") {
      index += 2;
      while (index < data.length && !(data.charCodeAt(index) >= 64 && data.charCodeAt(index) <= 126)) index += 1;
    } else if (kind === "]") {
      index += 2;
      while (index < data.length && data.charCodeAt(index) !== 7
        && !(data.charCodeAt(index) === 27 && data[index + 1] === "\\")) index += 1;
      if (data.charCodeAt(index) === 27) index += 1;
    }
  }
  return result;
}

/** Watches only output following a command the user sent to this Session. */
export class SavedPasswordPromptDetector {
  private inputLine = "";
  private promptPrefix: string | null = null;
  private inputEdited = false;
  private outputTail = "";
  private pendingUntil = 0;
  private offered = false;

  observeInput(data: string, now = Date.now(), cursorLine?: string) {
    if (this.pendingUntil) this.reset();
    this.promptPrefix ??= cursorLine ?? null;
    // History and readline edits change the remote line without sending its
    // text through onData. Bracketed paste, however, contains the actual text.
    const unwrapped = data.split("\x1b[200~").join("").split("\x1b[201~").join("");
    if ([...unwrapped].some((character) => READLINE_EDIT_CHARACTERS.includes(character))) {
      this.inputEdited = true;
    }
    for (const character of visibleTerminalText(data).replace(/\r\n/gu, "\r")) {
      if (character === "\x03" || character === "\x04") {
        this.reset();
      } else if (character === "\r" || character === "\n") {
        const command = this.inputEdited
          ? (this.promptPrefix !== null && cursorLine?.startsWith(this.promptPrefix)
            ? cursorLine.slice(this.promptPrefix.length) : "")
          : this.inputLine;
        if (/^\s*(?:sudo|su)(?:\s|$)/u.test(command)) {
          this.pendingUntil = now + PROMPT_WINDOW_MS;
          this.outputTail = "";
          this.offered = false;
        } else {
          this.pendingUntil = 0;
        }
        this.inputLine = "";
        this.promptPrefix = null;
        this.inputEdited = false;
      } else if (character === "\x7f" || character === "\b") {
        this.inputLine = this.inputLine.slice(0, -1);
      } else if (character >= " " && character !== "\x7f") {
        this.inputLine = (this.inputLine + character).slice(-512);
      }
    }
  }

  hasPendingCommand(now = Date.now()) {
    return this.pendingUntil > 0 && now <= this.pendingUntil && !this.offered;
  }

  observeOutput(data: string, now = Date.now(), cursorLine?: string) {
    if (!this.hasPendingCommand(now)) return false;
    this.outputTail = (this.outputTail + data).slice(-512);
    // Prefer xterm's parsed line: tmux may repaint its status bar and restore
    // the cursor after the prompt, so the raw stream need not end in Password:.
    if (!PASSWORD_PROMPT.test(cursorLine ?? visibleTerminalText(this.outputTail))) return false;
    this.offered = true;
    return true;
  }

  reset() {
    this.inputLine = "";
    this.promptPrefix = null;
    this.inputEdited = false;
    this.outputTail = "";
    this.pendingUntil = 0;
    this.offered = false;
  }
}
