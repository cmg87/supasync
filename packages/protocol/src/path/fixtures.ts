export type PathFixture = {
  name: string;
  input: string;
  expect: "ok" | "reject";
  pathKey?: string;
  display?: string;
};

export const PATH_CANON_FIXTURES: PathFixture[] = [
  {
    name: "dotted capital I",
    input: "İ.md",
    expect: "ok",
    display: "İ.md",
    pathKey: "i\u0307.md",
  },
  {
    name: "Greek final sigma",
    input: "ΟΣ.md",
    expect: "ok",
    display: "ΟΣ.md",
    pathKey: "οσ.md",
  },
  {
    name: "composed accent",
    input: "caf\u00e9/note.md",
    expect: "ok",
    display: "caf\u00e9/note.md",
    pathKey: "caf\u00e9/note.md",
  },
  {
    name: "decomposed accent",
    input: "cafe\u0301/note.md",
    expect: "ok",
    display: "caf\u00e9/note.md",
    pathKey: "caf\u00e9/note.md",
  },
  {
    name: "emoji",
    input: "notes/\u{1F4DD}.md",
    expect: "ok",
    display: "notes/\u{1F4DD}.md",
    pathKey: "notes/\u{1F4DD}.md",
  },
  {
    name: "non-ascii case pair",
    input: "Stra\u00dfe.md",
    expect: "ok",
    display: "Stra\u00dfe.md",
    pathKey: "strasse.md",
  },
  {
    name: "uppercase sharp s",
    input: "STRA\u1e9eE.md",
    expect: "ok",
    display: "STRA\u1e9eE.md",
    pathKey: "strasse.md",
  },
  {
    name: "case-only rename pair A",
    input: "Plan.md",
    expect: "ok",
    display: "Plan.md",
    pathKey: "plan.md",
  },
  {
    name: "case-only rename pair B",
    input: "plan.md",
    expect: "ok",
    display: "plan.md",
    pathKey: "plan.md",
  },
  {
    name: "reserved CON",
    input: "CON.md",
    expect: "reject",
  },
  {
    name: "reserved com1",
    input: "folder/COM1.txt",
    expect: "reject",
  },
  {
    name: "trailing space",
    input: "note.md ",
    expect: "reject",
  },
  {
    name: "trailing dot",
    input: "note.md.",
    expect: "reject",
  },
  {
    name: "traversal",
    input: "../secret.md",
    expect: "reject",
  },
  {
    name: "absolute",
    input: "/etc/passwd",
    expect: "reject",
  },
  {
    name: "backslash",
    input: "folder\\note.md",
    expect: "reject",
  },
  {
    name: "question mark",
    input: "question?.md",
    expect: "reject",
  },
  {
    name: "asterisk",
    input: "star*.md",
    expect: "reject",
  },
  {
    name: "double quote",
    input: 'quote".md',
    expect: "reject",
  },
  {
    name: "angle bracket",
    input: "less<than.md",
    expect: "reject",
  },
  {
    name: "pipe",
    input: "pipe|name.md",
    expect: "reject",
  },
  {
    name: "nul",
    input: "no\u0000te.md",
    expect: "reject",
  },
  {
    name: "empty component",
    input: "a//b.md",
    expect: "reject",
  },
];
