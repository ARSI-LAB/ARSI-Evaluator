export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []; let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (c === "," && !quoted) { row.push(cell); cell = ""; }
    else if (c === "\n" && !quoted) { row.push(cell.replace(/\r$/u, "")); if (row.some(Boolean)) rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (quoted) throw new TypeError("Unterminated CSV cell");
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const headers = rows.shift()?.map(s => s.replace(/^\uFEFF/u, "").trim());
  if (!headers?.length || headers.some(h => !h) || new Set(headers).size !== headers.length || !rows.length) throw new TypeError("Missing or duplicate CSV headers/measurements");
  return rows.map(values => {
    if (values.length !== headers.length) throw new TypeError("CSV row width mismatch");
    return Object.fromEntries(headers.map((h, i) => [h, values[i] ?? ""]));
  });
}
