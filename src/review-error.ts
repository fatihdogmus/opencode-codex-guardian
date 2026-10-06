export class ReviewError extends Error {
    constructor(readonly code: string) { super(code) }
}
