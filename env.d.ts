// A direct AssemblyAI endpoint uses this secret. It is optional when
// ASSEMBLYAI_API_URL points at a pre-authenticated relay.
interface Env {
  ASSEMBLYAI_API_KEY?: string;
  JOURNAL_LLM_API_URL?: string;
  JOURNAL_LLM_MODEL?: string;
  JOURNAL_LLM_API_KEY?: string;
  DEV_SOURCE_LIMIT?: string;
}
