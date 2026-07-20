#!/usr/bin/env python3
"""Package-independent client: executes only argv recipes returned by its pointer."""

import json
import os
import subprocess
import sys


def run(argv):
    completed = subprocess.run(argv, env=os.environ.copy(), capture_output=True, text=True)
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"command returned non-JSON stdout: {completed.stdout!r}; stderr={completed.stderr!r}") from error
    return {"exitCode": completed.returncode, "stdout": payload, "stderr": completed.stderr}


request = json.load(sys.stdin)
bootstrap_run = run(request["pointerArgv"])
if bootstrap_run["exitCode"] != 0:
    print(json.dumps({"bootstrap": bootstrap_run, "results": []}, ensure_ascii=False))
    sys.exit(0)

bootstrap = bootstrap_run["stdout"]
if bootstrap.get("contractVersion") != "tasq.autonomous-bootstrap.v1" or not isinstance(bootstrap.get("recipes"), list):
    raise RuntimeError(f"unsupported or malformed bootstrap contract: {bootstrap.get('contractVersion')!r}")
results = []
for action in request.get("actions", []):
    selector = action.get("selector")
    if selector is None:
        matches = [item for item in bootstrap["recipes"] if item.get("id") == action["recipeId"]]
        selection_label = action["recipeId"]
    else:
        parameter_names = sorted(selector.get("parameterNames", []))
        matches = [item for item in bootstrap["recipes"] if
                   item.get("outputContract") == selector.get("outputContract") and
                   item.get("mutates") == selector.get("mutates") and
                   (selector.get("requiredCapability") is None or
                    item.get("requiredCapability") == selector.get("requiredCapability")) and
                   sorted(parameter.get("name") for parameter in item.get("parameters", [])) == parameter_names]
        selection_label = json.dumps(selector, sort_keys=True)
    if len(matches) != 1:
        raise RuntimeError(f"discovery must advertise exactly one recipe matching {selection_label}")
    recipe = matches[0]
    if recipe.get("version") != 1 or not isinstance(recipe.get("argvTemplate"), list) or not isinstance(recipe.get("parameters"), list):
        raise RuntimeError(f"unsupported or malformed selected recipe {recipe.get('id')!r}")
    replacements = action.get("replacements", {})
    declared = {parameter["placeholder"] for parameter in recipe["parameters"]}
    if declared != set(replacements):
        raise RuntimeError(f"recipe parameters differ: declared={declared}, supplied={set(replacements)}")
    argv = [replacements.get(part, part) for part in recipe["argvTemplate"]]
    results.append({"selectedRecipeId": recipe["id"], **run(argv)})

print(json.dumps({"bootstrap": bootstrap_run, "results": results}, ensure_ascii=False))
