import type { Embedder } from "../../embed/model.ts";

export type Passage = { id: number; page: string; title: string; text: string };
export type SearchOptions = { embedder?: Embedder; dir?: string; indexFile?: string };
export type BuildMode = "stat" | "content" | "force";
