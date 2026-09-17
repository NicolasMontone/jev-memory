// Global test setup: provide a fake AI Gateway credential so
// `assertAuthConfigured()` never fires in unit tests (which mock
// `experimental_evaluate` at the module boundary and never touch the
// network). Individual tests that specifically exercise the missing-auth
// error path delete/restore this themselves.
process.env.AI_GATEWAY_API_KEY = 'test-gateway-key';
