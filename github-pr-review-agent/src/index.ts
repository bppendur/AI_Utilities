#!/usr/bin/env node
import "dotenv/config";
import { buildProgram } from "./cli.js";
import { createLogger, errorMessage } from "./logger.js";

buildProgram()
  .parseAsync(process.argv)
  .catch((error: unknown) => {
    // Route through the redacting logger, never a bare console.error: it
    // scrubs GITHUB_TOKEN/ANTHROPIC_API_KEY from anything logged, and only
    // errorMessage(error) is passed through — never the error itself or
    // `.cause`, whose default Node inspection would bypass redaction.
    createLogger("cli").error(`Fatal: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
