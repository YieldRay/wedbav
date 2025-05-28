const SYMBOL_RAW_STRING: unique symbol = Symbol();

/** A string that will not be escaped. */
interface RawString {
  [SYMBOL_RAW_STRING]: string;
}

export function isRawString(x: object): x is RawString {
  return SYMBOL_RAW_STRING in x;
}

/** Create a raw string that will not be escaped. */
export function raw(string: string): RawString {
  return { [SYMBOL_RAW_STRING]: string };
}

type Arg = string | RawString | (string | RawString)[];

export function html({ raw }: TemplateStringsArray, ...args: Arg[]): string {
  const len = raw.length - 1;
  let s = "";
  for (let i = 0; i < len; i++) {
    s += raw[i] + stringify(args[i]);
  }
  return s + raw[len];
}

function stringify(arg: Arg): string {
  switch (typeof arg) {
    case "string":
      return escape(arg);
    default: {
      if (isRawString(arg)) {
        return arg[SYMBOL_RAW_STRING];
      } else {
        return arg.map(stringify).join("");
      }
    }
  }
}

/** Escape a string for safe usage in HTML. */
export function escape(str: string): string {
  return str.replaceAll(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
