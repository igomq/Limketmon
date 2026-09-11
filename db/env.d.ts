declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    /** Server-only secret coupon code. Unset or blank disables the private coupon route. */
    PRIVATE_CARD_COUPON?: string;
  }
}
