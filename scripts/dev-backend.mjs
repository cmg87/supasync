#!/usr/bin/env node
import { spawn } from "node:child_process";

const child = spawn("supabase", ["start"], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
