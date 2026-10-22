/** Process entry: run the CLI, flush output, exit with its code. */
import { nodeIo, run } from "./main.ts";

const code = await run(process.argv.slice(2), nodeIo());
// Exit explicitly so idle keep-alive sockets cannot delay the process, after stdout drains.
process.stdout.write("", () => process.exit(code));
