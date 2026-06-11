/**
 * Terminal UI helpers (zero dependencies): ANSI colors that respect
 * NO_COLOR / non-TTY, an ASCII banner, a lightweight markdown renderer,
 * and a multi-line live progress block on stderr.
 */
const useColor = !!process.stdout.isTTY && !process.env.NO_COLOR;

const wrap =
  (open: number, close: number) =>
  (s: string): string =>
    useColor ? `\x1b[${open}m${s}\x1b[${close}m` : s;

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const cyan = wrap(36, 39);
export const magenta = wrap(35, 39);

const ART = [
  '     ██╗ █████╗  ██████╗██╗  ██╗',
  '     ██║██╔══██╗██╔════╝██║ ██╔╝',
  '     ██║███████║██║     █████╔╝ ',
  '██   ██║██╔══██║██║     ██╔═██╗ ',
  '╚█████╔╝██║  ██║╚██████╗██║  ██╗',
  ' ╚════╝ ╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝',
];

export function banner(version: string, tagline: string): void {
  console.log('');
  for (const [i, line] of ART.entries()) {
    // Alternate magenta/cyan for a cheap gradient effect.
    console.log(`  ${i < 3 ? magenta(line) : cyan(line)}`);
  }
  console.log(`\n  ${magenta('🎩')} ${dim(`v${version}`)} — ${dim(tagline)}\n`);
}

/** Minimal markdown styling for reports: headings, bold, inline code, fences, bullets. */
export function renderMarkdown(md: string): string {
  let inFence = false;
  return md
    .split('\n')
    .map((line) => {
      if (line.trimStart().startsWith('```')) {
        inFence = !inFence;
        return dim(line);
      }
      if (inFence) return cyan(line);
      let styled = line;
      if (/^#{1,6}\s/.test(styled)) return bold(styled.replace(/^#+\s/, ''));
      styled = styled.replace(/\*\*([^*]+)\*\*/g, (_, s: string) => bold(s));
      styled = styled.replace(/`([^`]+)`/g, (_, s: string) => cyan(s));
      styled = styled.replace(/^(\s*)-\s/, '$1• ');
      return styled;
    })
    .join('\n');
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

type LineState = 'spin' | 'ok' | 'err' | 'info';

interface ProgressLine {
  text: string;
  state: LineState;
}

/**
 * Multi-line live progress on stderr: one line per task, redrawn in place.
 * Falls back to plain sequential logging when stderr is not a TTY.
 */
export class MultiProgress {
  private readonly lines = new Map<string, ProgressLine>();
  private rendered = 0;
  private timer?: NodeJS.Timeout;
  private frame = 0;
  private readonly enabled = !!process.stderr.isTTY;

  start(): void {
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => this.render(), 80);
  }

  /** Create or update a line in 'spin' state. */
  spin(key: string, text: string): void {
    this.upsert(key, text, 'spin');
  }

  info(key: string, text: string): void {
    this.upsert(key, text, 'info');
  }

  ok(key: string, text: string): void {
    this.upsert(key, text, 'ok');
  }

  err(key: string, text: string): void {
    this.upsert(key, text, 'err');
  }

  /** Final render (no spinner frames) and release the screen region. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.enabled) {
      this.render(true);
      this.rendered = 0; // leave the final block in place
    }
    this.lines.clear();
  }

  private upsert(key: string, text: string, state: LineState): void {
    const prev = this.lines.get(key);
    this.lines.set(key, { text, state });
    if (!this.enabled && (!prev || prev.state !== state) && state !== 'spin') {
      console.error(this.plain({ text, state }));
    }
  }

  private plain(line: ProgressLine): string {
    const mark =
      line.state === 'ok'
        ? green('✓')
        : line.state === 'err'
          ? red('✗')
          : line.state === 'info'
            ? dim('·')
            : cyan(FRAMES[this.frame] ?? '⠋');
    return `  ${mark} ${line.text}`;
  }

  private render(final = false): void {
    if (!this.enabled) return;
    this.frame = (this.frame + 1) % FRAMES.length;
    const width = process.stderr.columns || 80;
    const block = [...this.lines.values()]
      .map((line) => {
        const text = this.plain(final && line.state === 'spin' ? { ...line, state: 'info' } : line);
        // Hard-truncate so wrapped lines never break the cursor math
        // (measured without ANSI codes; over-long lines lose their colors).
        // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes is the point
        const visible = text.replace(/\x1b\[[0-9;]*m/g, '');
        return visible.length > width ? `${visible.slice(0, width - 1)}…` : text;
      })
      .join('\n');
    const up = this.rendered > 0 ? `\x1b[${this.rendered}A` : '';
    process.stderr.write(`${up}\x1b[0J${block}\n`);
    this.rendered = this.lines.size;
  }
}
