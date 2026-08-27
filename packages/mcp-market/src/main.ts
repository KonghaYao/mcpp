import { loadConfig } from "./config.ts";import { openDatabase } from "./db/database.ts";import { createApp } from "./app.ts";
const config=loadConfig(),db=await openDatabase(config.dbPath),app=createApp(db,config);Bun.serve({port:config.port,hostname:config.host,fetch:app.fetch});console.info(`MCPM listening on ${config.port}`);
