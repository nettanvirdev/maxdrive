/**
 * Just enough XML for S3's responses: flat, namespaced-but-predictable
 * documents. Not a general parser - S3 never nests a tag inside a tag of the
 * same name, which is all these regexes rely on.
 */
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code =
        e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return String.fromCodePoint(code);
    }
    return ENTITIES[e] ?? m;
  });
}

/** Inner text of the first <name>…</name>, decoded; null when absent. */
function tag(xml, name) {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? decode(m[1]) : null;
}

/** Raw inner XML of every <name>…</name> block, for repeated elements. */
function blocks(xml, name) {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "g");
  return [...xml.matchAll(re)].map((m) => m[1]);
}

const escape = (s) =>
  String(s).replace(/[<>&'"]/g, (c) => `&${{ "<": "lt", ">": "gt", "&": "amp", "'": "apos", '"': "quot" }[c]};`);

module.exports = { tag, blocks, decode, escape };
