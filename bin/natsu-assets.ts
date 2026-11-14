#!/usr/bin/env bun
import { Assets, type AssetsOptions } from "../src/assets.ts";
import { runCli } from "../src/assets/cli.ts";

process.exit(await runCli(process.argv.slice(2), { create: (options) => new Assets(options as AssetsOptions) }));
