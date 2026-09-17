import * as Schema from "effect/Schema"

/**
 * The normalized vendor transcript every provider maps into. Timestamps are
 * milliseconds from the start of the submitted audio; `confidence` is null
 * when the provider does not supply one (Meta Muse Voice does not).
 */
export class VendorTranscript extends Schema.Class<VendorTranscript>("VendorTranscript")({
  id: Schema.String,
  status: Schema.Literals(["queued", "processing", "completed", "error"]),
  text: Schema.optional(Schema.NullOr(Schema.String)),
  utterances: Schema.optional(Schema.NullOr(Schema.Array(Schema.Struct({
    speaker: Schema.optional(Schema.NullOr(Schema.String)),
    start: Schema.Number,
    end: Schema.Number,
    text: Schema.String,
    confidence: Schema.optional(Schema.NullOr(Schema.Number))
  })))),
  error: Schema.optional(Schema.NullOr(Schema.String))
}) {}
