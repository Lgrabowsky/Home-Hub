/**
 * Reader for STEP physical files (ISO 10303-21), the text format IFC models are
 * exchanged in. It reads the DATA section into a map of entity instances; it
 * knows nothing about IFC itself.
 *
 *   #12=IFCCARTESIANPOINT((0.,1.5,2.));
 *   #13=IFCPOLYLOOP((#12,#14,#15));
 */

/** Reference to another instance (`#42`). */
export class Ref {
  constructor(readonly id: number) {}
}

/** Enumeration value (`.ELEMENT.`, booleans `.T.` / `.F.`). */
export class Enum {
  constructor(readonly value: string) {}
}

/** A value wrapped in its type, e.g. `IFCLABEL('Wand')` inside a SELECT. */
export class Typed {
  constructor(
    readonly type: string,
    readonly value: StepValue,
  ) {}
}

/** `null` stands for both "unset" (`$`) and "derived" (`*`). */
export type StepValue = number | string | Ref | Enum | Typed | null | StepValue[];

export interface StepEntity {
  id: number;
  /** Upper case, e.g. `IFCWALL`. */
  type: string;
  args: StepValue[];
}

export class StepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StepError';
  }
}

export interface StepFile {
  schema: string;
  /** From FILE_NAME: the program that wrote the file (for diagnostics only). */
  application: string;
  entities: Map<number, StepEntity>;
  byType: Map<string, number[]>;
}

const CODE_0 = 48;
const CODE_9 = 57;

function isDigit(code: number): boolean {
  return code >= CODE_0 && code <= CODE_9;
}

function isKeywordChar(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || isDigit(code) || code === 95; // A-Z a-z 0-9 _
}

/**
 * Decodes the escapes of STEP strings: `''` (quote), `\\` (backslash),
 * `\X2\00FC\X0\` (UTF-16), `\X4\…\X0\` (UTF-32), `\X\FC` (ISO 8859-1) and
 * `\S\|` (upper half of the active code page, taken as ISO 8859-1).
 */
export function decodeStepString(raw: string): string {
  if (!raw.includes('\\') && !raw.includes("''")) return raw;
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch === "'" && raw[i + 1] === "'") {
      out += "'";
      i += 2;
      continue;
    }
    if (ch !== '\\') {
      out += ch;
      i++;
      continue;
    }
    const rest = raw.slice(i);
    let match: RegExpExecArray | null;
    if ((match = /^\\X2\\((?:[0-9A-Fa-f]{4})*)\\X0\\/.exec(rest))) {
      const hex = match[1]!;
      const units: number[] = [];
      for (let k = 0; k < hex.length; k += 4) units.push(parseInt(hex.slice(k, k + 4), 16));
      out += String.fromCharCode(...units);
      i += match[0].length;
    } else if ((match = /^\\X4\\((?:[0-9A-Fa-f]{8})*)\\X0\\/.exec(rest))) {
      const hex = match[1]!;
      for (let k = 0; k < hex.length; k += 8) out += String.fromCodePoint(parseInt(hex.slice(k, k + 8), 16));
      i += match[0].length;
    } else if ((match = /^\\X\\([0-9A-Fa-f]{2})/.exec(rest))) {
      out += String.fromCharCode(parseInt(match[1]!, 16));
      i += match[0].length;
    } else if (rest.startsWith('\\S\\') && rest.length >= 4) {
      out += String.fromCharCode(rest.charCodeAt(3) + 128);
      i += 4;
    } else if ((match = /^\\P[A-I]\\/.exec(rest))) {
      i += match[0].length; // code page switch: ignored
    } else if (rest.startsWith('\\\\')) {
      out += '\\';
      i += 2;
    } else {
      out += '\\';
      i++;
    }
  }
  return out;
}

class Scanner {
  pos = 0;
  constructor(readonly text: string) {}

  fail(message: string): never {
    // Line numbers make a broken file explainable to whoever exported it.
    const line = this.text.slice(0, this.pos).split('\n').length;
    throw new StepError(`${message} (Zeile ${line})`);
  }

  skip(): void {
    const { text } = this;
    for (;;) {
      const code = text.charCodeAt(this.pos);
      if (code === 32 || code === 9 || code === 10 || code === 13) {
        this.pos++;
      } else if (code === 47 && text.charCodeAt(this.pos + 1) === 42) {
        const end = text.indexOf('*/', this.pos + 2);
        this.pos = end < 0 ? text.length : end + 2;
      } else {
        return;
      }
    }
  }

  expect(char: string): void {
    this.skip();
    if (this.text[this.pos] !== char) this.fail(`„${char}“ erwartet`);
    this.pos++;
  }

  keyword(): string {
    const start = this.pos;
    while (this.pos < this.text.length && isKeywordChar(this.text.charCodeAt(this.pos))) this.pos++;
    return this.text.slice(start, this.pos).toUpperCase();
  }

  value(): StepValue {
    this.skip();
    const { text } = this;
    const ch = text[this.pos];
    switch (ch) {
      case '$':
      case '*':
        this.pos++;
        return null;
      case '#': {
        this.pos++;
        const start = this.pos;
        while (isDigit(text.charCodeAt(this.pos))) this.pos++;
        if (start === this.pos) this.fail('Verweis ohne Nummer');
        return new Ref(Number(text.slice(start, this.pos)));
      }
      case "'": {
        let end = this.pos + 1;
        for (;;) {
          end = text.indexOf("'", end);
          if (end < 0) this.fail('Zeichenkette ohne Ende');
          if (text[end + 1] === "'") {
            end += 2;
            continue;
          }
          break;
        }
        const raw = text.slice(this.pos + 1, end);
        this.pos = end + 1;
        return decodeStepString(raw);
      }
      case '"': {
        const end = text.indexOf('"', this.pos + 1);
        if (end < 0) this.fail('Binärwert ohne Ende');
        const raw = text.slice(this.pos + 1, end);
        this.pos = end + 1;
        return raw;
      }
      case '.': {
        if (isDigit(text.charCodeAt(this.pos + 1))) return this.number();
        const end = text.indexOf('.', this.pos + 1);
        if (end < 0) this.fail('Aufzählungswert ohne Ende');
        const raw = text.slice(this.pos + 1, end);
        this.pos = end + 1;
        return new Enum(raw.toUpperCase());
      }
      case '(':
        return this.list();
      default: {
        const code = text.charCodeAt(this.pos);
        if (isDigit(code) || ch === '-' || ch === '+') return this.number();
        if (isKeywordChar(code)) {
          const type = this.keyword();
          this.expect('(');
          const inner = this.value();
          this.expect(')');
          return new Typed(type, inner);
        }
        return this.fail('Unerwartetes Zeichen');
      }
    }
  }

  number(): number {
    const { text } = this;
    const start = this.pos;
    if (text[this.pos] === '-' || text[this.pos] === '+') this.pos++;
    while (this.pos < text.length) {
      const code = text.charCodeAt(this.pos);
      if (isDigit(code) || code === 46 /* . */) {
        this.pos++;
      } else if (code === 69 || code === 101 /* E e */) {
        this.pos++;
        if (text[this.pos] === '-' || text[this.pos] === '+') this.pos++;
      } else {
        break;
      }
    }
    const value = Number(text.slice(start, this.pos));
    if (!Number.isFinite(value)) this.fail('Ungültige Zahl');
    return value;
  }

  list(): StepValue[] {
    this.expect('(');
    const items: StepValue[] = [];
    this.skip();
    if (this.text[this.pos] === ')') {
      this.pos++;
      return items;
    }
    for (;;) {
      items.push(this.value());
      this.skip();
      const ch = this.text[this.pos];
      if (ch === ',') {
        this.pos++;
        continue;
      }
      if (ch === ')') {
        this.pos++;
        return items;
      }
      this.fail('„,“ oder „)“ erwartet');
    }
  }

  /** Skips a complex instance `(IFCA(...)IFCB(...))` — IFC models practically never need them. */
  skipComplex(): void {
    let depth = 0;
    const { text } = this;
    while (this.pos < text.length) {
      const ch = text[this.pos]!;
      if (ch === "'") {
        this.value();
        continue;
      }
      this.pos++;
      if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) return;
    }
    this.fail('Unvollständige Instanz');
  }
}

/** Parses a whole STEP file. Throws `StepError` (German message) for files it cannot read. */
export function parseStep(text: string): StepFile {
  if (!/^\s*ISO-10303-21\s*;/.test(text.slice(0, 200))) {
    throw new StepError('Das ist keine IFC-Datei (es fehlt die Kennung „ISO-10303-21“). Bitte das Modell als .ifc exportieren, nicht als .ifczip oder .ifcxml.');
  }
  const header = text.slice(0, Math.min(text.length, 20_000));
  const schema = /FILE_SCHEMA\s*\(\s*\(\s*'([^']*)'/i.exec(header)?.[1]?.toUpperCase() ?? '';
  // FILE_NAME(name, time_stamp, (author), (organization), preprocessor_version, originating_system, authorization)
  let application = '';
  const fileName = /FILE_NAME\s*(?=\()/i.exec(header);
  if (fileName) {
    try {
      const reader = new Scanner(text);
      reader.pos = fileName.index + fileName[0].length;
      const fields = reader.list();
      const pick = (value: StepValue | undefined) => (typeof value === 'string' ? value.trim() : '');
      application = pick(fields[5]) || pick(fields[4]);
    } catch {
      /* the header is only for information */
    }
  }

  const data = /\bDATA\s*;/.exec(text);
  if (!data) throw new StepError('Die IFC-Datei enthält keinen DATA-Abschnitt.');
  const scanner = new Scanner(text);
  scanner.pos = data.index + data[0].length;

  const entities = new Map<number, StepEntity>();
  const byType = new Map<string, number[]>();
  for (;;) {
    scanner.skip();
    if (scanner.pos >= text.length) break;
    if (text[scanner.pos] !== '#') {
      const word = scanner.keyword();
      if (word === 'ENDSEC') break;
      scanner.fail('Instanz erwartet');
    }
    scanner.pos++;
    const start = scanner.pos;
    while (isDigit(text.charCodeAt(scanner.pos))) scanner.pos++;
    const id = Number(text.slice(start, scanner.pos));
    scanner.expect('=');
    scanner.skip();
    if (text[scanner.pos] === '(') {
      scanner.skipComplex();
      scanner.expect(';');
      continue;
    }
    const type = scanner.keyword();
    if (!type) scanner.fail('Typname erwartet');
    const args = scanner.list();
    scanner.expect(';');
    entities.set(id, { id, type, args });
    let list = byType.get(type);
    if (!list) byType.set(type, (list = []));
    list.push(id);
  }
  return { schema, application, entities, byType };
}
