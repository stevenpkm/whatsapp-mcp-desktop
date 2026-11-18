// libsignal (inside the WhatsApp library) prints whole session records with
// console.info, private keys included, and those lines land in helper.log.
// From here on console prints only words: strings, numbers and error
// messages. Objects are dropped, so no key or message ever reaches a log.

const methods = ["log", "info", "warn", "error", "debug"] as const;
for (const name of methods) {
  const original = console[name].bind(console);
  console[name] = (...args: unknown[]) => {
    const words = args.flatMap((a) => (typeof a === "string" || typeof a === "number" ? [String(a)] : a instanceof Error ? [a.message] : []));
    if (words.length) original(...words);
  };
}

export {};
