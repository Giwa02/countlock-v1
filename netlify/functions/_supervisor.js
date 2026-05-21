// Supervisor gate for Training Mode endpoints.
//
// CountLock has no user auth today (operator UI is unauthenticated by design,
// service-role functions + a hardcoded org). The Training Mode spec assumes
// supervisor/operator JWTs that don't exist here. Rather than bolt a full
// Supabase Auth system onto a shop-floor tablet app (out of scope, and it
// would change how every operator uses CountLock), Training Mode is gated by
// a shared SUPERVISOR_PASSCODE.
//
// Intent matches the spec's security requirement: operators cannot upload
// training images or trigger training. Clean upgrade path to real JWT roles
// when CountLock gets full auth.
//
// The passcode is sent by the frontend in the x-countlock-supervisor header
// (held in memory for the session, never written to disk).

import { getEnv } from "./_roboflow.js";
import { json } from "./_supabase.js";

/**
 * Returns null if the request carries a valid supervisor passcode.
 * Otherwise returns a 403 response object the caller should return directly.
 *
 *   const denied = requireSupervisor(event);
 *   if (denied) return denied;
 */
export function requireSupervisor(event) {
  const expected = getEnv("SUPERVISOR_PASSCODE");

  // Fail closed: if no passcode is configured, training endpoints are locked
  // entirely rather than open to everyone.
  if (!expected) {
    return json(
      { error: { code: "SUPERVISOR_NOT_CONFIGURED", message: "Training Mode is not enabled on this deployment." } },
      403
    );
  }

  const headers = event.headers || {};
  const provided =
    headers["x-countlock-supervisor"] || headers["X-Countlock-Supervisor"] || "";

  // Constant-time-ish compare (length check first, then char accumulate).
  if (!provided || !safeEqual(String(provided), String(expected))) {
    return json(
      { error: { code: "SUPERVISOR_REQUIRED", message: "Supervisor passcode required." } },
      403
    );
  }

  return null;
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
