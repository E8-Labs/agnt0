import { main } from "./program.js";

const [major] = process.versions.node.split(".").map(Number);
if ((major ?? 0) < 20) {
  console.error(`agnt0 needs Node.js 20 or newer (you have ${process.versions.node}).`);
  process.exit(1);
}

void main();
