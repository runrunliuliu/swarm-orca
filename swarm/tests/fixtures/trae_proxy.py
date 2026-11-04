"""Offline fake byte proxy used by test_trae_ledger; never invokes Trae or models."""
import json
import sys
import time

mode = sys.argv[1]
for line in sys.stdin:
    request = json.loads(line)
    method = request["method"]
    if method == "initialized":
        continue
    if method not in ("initialize", "thread/read"):
        raise AssertionError("unexpected mutation")
    if mode == "timeout":
        time.sleep(10)
    if mode == "eof":
        break
    if mode == "request":
        print(json.dumps({"id": 90, "method": "item/commandExecution/requestApproval", "params": {"command": "SECRET"}}), flush=True)
        continue
    if mode == "error":
        print(json.dumps({"id": request["id"], "error": {"message": "SECRET"}}), flush=True)
        continue
    if mode == "malformed":
        print("SECRET invalid JSON", flush=True)
        continue
    rid = request["id"] + 1 if mode == "wrong_id" else request["id"]
    if method == "initialize":
        result = {"userAgent": "traecli/0.209.1", "codexHome": "/SECRET", "platformOs": "linux", "platformFamily": "unix"}
    else:
        assert request["params"] == {"threadId": "thread-1", "includeTurns": True}
        result = {"thread": {"id": "thread-1", "sessionId": "tree-1", "createdAt": 1791849600,
                             "cliVersion": "0.209.1", "status": {"type": "idle"}, "turns": [], "preview": "SECRET"},
                  "tokenUsage": None}
        if mode == "large":
            result["thread"]["preview"] = "SECRET" + "x" * (33 * 1024 * 1024)
    # Unrelated notifications must not be billed or answer an approval.
    print(json.dumps({"method": "thread/tokenUsage/updated", "params": {"SECRET": 9999}}), flush=True)
    print(json.dumps({"id": rid, "result": result}), flush=True)
