/**
 * Whether JERRY starts an added skill for a task (state and kind of change). The rule lives in the
 * contracts' dependency-free constants so the MCP server and the gate (bundled into the hook bridge)
 * share it.
 */
export { skillApplies } from '@jerry/contracts/constants';
