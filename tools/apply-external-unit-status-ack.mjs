import fs from 'fs';

function replaceExact(source, search, replacement, label) {
  if (!source.includes(search)) {
    throw new Error(`Missing expected text for ${label}`);
  }
  return source.replace(search, replacement);
}

const servicePath = 'src/services/aiDispatchService.js';
let service = fs.readFileSync(servicePath, 'utf8');

service = replaceExact(
  service,
  `          let statusUpdateFailed = false;\n          let statusFailureType = null;`,
  `          let statusUpdateFailed = false;\n          let statusFailureType = null;\n          let statusExternalUnit = false;`,
  'status failure state',
);

service = replaceExact(
  service,
  `                if (!cadResult || !cadResult.success) {\n                  statusUpdateFailed = true;\n                  statusFailureType = cadResult?.failureType || 'API_REJECTION';\n                  this.log('CAD_STATUS_UPDATE_FAILED', { unitId: participantId, status: result.cadStatus, failureType: statusFailureType, error: cadResult?.error, statusCode: cadResult?.statusCode, responseBody: cadResult?.responseBody });\n                }`,
  `                if (!cadResult || !cadResult.success) {\n                  statusUpdateFailed = true;\n                  statusFailureType = cadResult?.failureType || 'API_REJECTION';\n                  statusExternalUnit = cadResult?.responseBody?.error === 'external_unit_not_in_dispatch_center';\n                  this.log('CAD_STATUS_UPDATE_FAILED', { unitId: participantId, status: result.cadStatus, failureType: statusFailureType, externalUnit: statusExternalUnit, error: cadResult?.error, statusCode: cadResult?.statusCode, responseBody: cadResult?.responseBody });\n                }`,
  'external unit status detection',
);

service = replaceExact(
  service,
  `          if (statusUpdateFailed && statusFailureType === 'NOT_CONFIGURED') {\n            statusResp = \`${'${participantId}'}, 10-4. CAD is not available, update your status via the MDT.\`;\n          } else if (statusUpdateFailed && statusFailureType === 'UNREACHABLE') {\n            statusResp = \`${'${participantId}'}, 10-4. Unable to reach CAD, update your status via the MDT.\`;\n          } else if (statusUpdateFailed) {\n            statusResp = \`${'${participantId}'}, 10-4. CAD update did not go through, try your MDT.\`;\n          } else {`,
  `          if (statusExternalUnit) {\n            statusResp = \`${'${participantId}'}, 10-4. I can hear you, but I can't change your CAD status from this dispatch center.\`;\n          } else if (statusUpdateFailed && statusFailureType === 'NOT_CONFIGURED') {\n            statusResp = \`${'${participantId}'}, 10-4. CAD is not available, update your status via the MDT.\`;\n          } else if (statusUpdateFailed && statusFailureType === 'UNREACHABLE') {\n            statusResp = \`${'${participantId}'}, 10-4. Unable to reach CAD, update your status via the MDT.\`;\n          } else if (statusUpdateFailed) {\n            statusResp = \`${'${participantId}'}, 10-4. CAD update did not go through, try your MDT.\`;\n          } else {`,
  'external unit spoken acknowledgement',
);

fs.writeFileSync(servicePath, service);

const testPath = 'src/services/__tests__/aiDispatch.task541.test.js';
let test = fs.readFileSync(testPath, 'utf8');
const marker = `\n});\n\ndescribe('Task #541: clear/available primary_last skips "Close the call?" hail', () => {`;
const addition = `\n\n  it('acknowledges outside-center status traffic without sending the unit to the MDT', async () => {\n    const llm = await import('../llmIntentService.js');\n    llm.isConfigured.mockReturnValue(true);\n    llm.classifyIntent.mockResolvedValue({\n      intent: 'STATUS_CHANGE', cadStatus: 'available', slots: {}, response: null,\n    });\n    cadService.resolveUnitCurrentCall.mockResolvedValue({\n      callNumber: null, has_active_call: false, source: 'none',\n    });\n    cadService.updateUnitStatus.mockResolvedValueOnce({\n      success: false,\n      failureType: 'API_REJECTION',\n      error: 'external_unit_not_in_dispatch_center',\n      responseBody: {\n        error: 'external_unit_not_in_dispatch_center',\n        external_unit: true,\n      },\n    });\n\n    const d = makeDispatcher();\n    await d.processTranscriptWithLLM('10-8', 'INDIANA-1');\n\n    expect(d.spoken[0]).toBe(\"INDIANA-1, 10-4. I can hear you, but I can't change your CAD status from this dispatch center.\");\n    expect(d.spoken[0]).not.toMatch(/MDT|did not go through/i);\n    expect(d.logs.some(l => l.event === 'CAD_STATUS_UPDATE_FAILED'\n      && l.payload.externalUnit === true)).toBe(true);\n  });`;

test = replaceExact(
  test,
  marker,
  `${addition}${marker}`,
  'external unit status regression test',
);

fs.writeFileSync(testPath, test);
console.log('[patch] External unit status acknowledgement applied');
