// Function body used only with the reviewed local generator's plan and actual session tools.
return (async () => {
  const operations = [];
  const started = Date.now();
  const quote = s => "'" + s.replaceAll("'", "'\"'\"'") + "'";
  const addPatch = files => "*** Begin Patch\n" + Object.entries(files).map(([p, body]) =>
    "*** Add File: " + p + "\n" + body.trimEnd().split("\n").map(l => "+" + l + "\n").join("")
  ).join("") + "*** End Patch";
  const stop = code => { throw new Error(code); };
  const checkAge = () => {
    const age = Date.now() - Date.parse(plan.session.observed_at);
    if (!Number.isFinite(age) || age < -5000 || age > plan.evidence_max_age_seconds * 1000)
      stop("preparation_session_expired");
  };
  const record = async (name, call) => {
    const operation = {name, started_at:new Date().toISOString()};
    operations.push(operation);
    try {
      operation.result = await call();
      return operation.result;
    } catch (error) {
      operation.error = String(error.message || error);
      throw error;
    } finally { operation.completed_at = new Date().toISOString(); }
  };
  const patch = async (name, body) => {
    checkAge();
    const r = await record(name, () => tools.apply_patch(body));
    // Some hosts return {} on success. That is not proof: the next exact-byte
    // readback is mandatory. Explicit errors and other unknown formats stop here.
    const text = typeof r === "string" ? r : JSON.stringify(r);
    const emptyHostReceipt = r && typeof r === "object" && Object.keys(r).length === 0;
    if (r?.isError || r?.error || (!emptyHostReceipt && !text?.includes("Success. Updated the following files:")))
      stop(name + "_not_confirmed");
  };
  const read = async (name, files, absent = []) => {
    checkAge();
    const spec = JSON.stringify({directories: plan.directories, files, absent,
      ...(plan.binding ? {binding:plan.binding} : {})});
    const cmd = [...plan.verify_argv, spec].map(quote).join(" ");
    let r = await record(name, () => tools.exec_command({cmd, yield_time_ms:1000, max_output_tokens:4000}));
    let output = r.output || "";
    while (r.session_id) {
      r = await record(name + "_wait", () => tools.write_stdin({session_id:r.session_id, chars:"", yield_time_ms:1000, max_output_tokens:4000}));
      output += r.output || "";
    }
    if (r.exit_code !== 0) stop(name + "_failed");
    const result = JSON.parse(output);
    if (result.ok !== true) stop(name + "_failed");
    return result;
  };
  try {
    await read("check_paths", {}, plan.absent);
    if (plan.reused_file_tool) {
      await read("revalidate_original_probe",
        {...plan.probe.files, ...plan.reuse_source_files}, plan.probe.absent);
    } else {
      await patch("apply_patch_create", plan.create_patch);
      await read("read_created", plan.created_files, Object.keys(plan.renamed_files));
      await patch("apply_patch_rename", plan.move_patch);
      await read("read_renamed", plan.renamed_files, Object.keys(plan.created_files));
    }
    const completed = new Date().toISOString();
    const fileTool = plan.reused_file_tool
      ? {...plan.reused_file_tool, revalidated_at:completed, preparation:plan.preparation}
      : {...plan.identity, completed_at: completed, passed:true, batch_count:1,
      roots:plan.directories.map(d => d.path),
      actual_tools:["apply_patch_write", "exec_command_read", "apply_patch_rename", "exec_command_read"],
      operations_path:plan.outputs.operations,
      ...(plan.probe ? {probe:plan.probe, preparation:plan.preparation,
        session_context_sha256:plan.session_context_sha256} : {})};
    const evidence = {
      [plan.outputs.session]: JSON.stringify(plan.session) + "\n",
      [plan.outputs.file_tool]: JSON.stringify(fileTool) + "\n",
      [plan.outputs.operations]: JSON.stringify({schema_version:1, ...plan.identity,
        started_at:plan.started_at, completed_at:completed, generation_ms:plan.generation_ms,
        tools_ms:Date.now()-started, operations,
        ...(plan.preparation ? {preparation:plan.preparation,
          file_tool_reused:!!plan.reused_file_tool, reuse_source:fileTool.reuse_source || null} : {})}) + "\n"
    };
    await read("check_receipt_paths", {}, Object.values(plan.outputs));
    await patch("apply_patch_receipts", addPatch(evidence));
    const verified = await read("read_receipts", evidence);
    return {ok:true, decision:"run_native_preflight", ...plan.identity, batch_count:1,
      roots:plan.directories.length, generation_ms:plan.generation_ms, tools_ms:Date.now()-started,
      evidence:plan.outputs, sha256:verified.sha256};
  } catch (error) {
    // Do not use another tool/path to recover, delete partial files, or auto-retry.
    // Original results remain in the caller's tool trace on failure.
    return {ok:false, decision:"stop", ...plan.identity, code:String(error.message || error),
      attempted_operations:operations.map(o => o.name), failed_operation:operations.at(-1),
      evidence:plan.outputs};
  }
})();
