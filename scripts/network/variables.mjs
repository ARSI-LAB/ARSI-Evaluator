import { loadNetworkConfig } from "../../dist/config/network.js";
const document = await loadNetworkConfig();
if (process.argv[2] === "--path") {
  console.log(document.origin);
} else {
  const variables = [...new Set([...JSON.stringify(document.template).matchAll(/\$\{([A-Za-z_]\w*)\}/gu)].map(match => match[1]))];
  // Only names cross stdout; Docker reads their values from the invoking environment.
  for (const variable of variables) console.log(variable);
}
