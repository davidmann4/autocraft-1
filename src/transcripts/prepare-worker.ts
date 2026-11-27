// Worker thread that prepares submitted transcripts for storage (prepare.ts), off the dashboard's event loop.
import { serveCalls } from "../thread-call.ts";
import { prepareTranscript, type PrepareInput, type Prepared } from "./prepare.ts";

serveCalls<PrepareInput, Prepared>(prepareTranscript);
