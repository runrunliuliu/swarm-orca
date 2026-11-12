// The single marker the immutability trigger consults before admitting a DELETE (§6.2, §11.5).
//
// Shared by the schema (which embeds it in the trigger body) and by prune (which sets it inside its
// own transaction). One constant, so a rename cannot leave the trigger reading a key nobody writes —
// which would either block every prune or, worse, allow every delete.

export const PRUNE_FLAG_TABLE = 'incident_store_meta'
export const VERIFIED_PRUNE_FLAG = 'prune_deleting'
