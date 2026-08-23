/** Domain error with a stable code; routes map codes to UI messages. */
export class ServiceError extends Error {
	constructor(
		public code: string,
		message: string
	) {
		super(message);
	}
}
