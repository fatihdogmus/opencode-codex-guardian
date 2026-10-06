import { Rpc } from "@opencode/plugin/rpc"

export const AutoReviewRPC = Rpc.define({
    id: "auto-review",
    events: {},
    methods: {
        status: { input: { type: "object", additionalProperties: false }, output: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } },
    },
})
