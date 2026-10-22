#include <node_api.h>
#include <windows.h>
#include <stdio.h>

// Non-inheritable: only the adapter holds this handle, until OS process exit.
static HANDLE job = NULL;

static napi_value fail(napi_env env, const char* operation, DWORD error) {
  char message[160];
  snprintf(message, sizeof(message), "%s failed: Windows error %lu", operation, error);
  napi_throw_error(env, NULL, message);
  return NULL;
}

static napi_value join(napi_env env, napi_callback_info info) {
  if (!job) {
    HANDLE candidate = CreateJobObjectW(NULL, NULL);
    if (!candidate) return fail(env, "CreateJobObject", GetLastError());
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(candidate, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
      DWORD error = GetLastError();
      CloseHandle(candidate);
      return fail(env, "SetInformationJobObject", error);
    }
    // Join before spawning Pi: descendants inherit membership without a race.
    if (!AssignProcessToJobObject(candidate, GetCurrentProcess())) {
      DWORD error = GetLastError();
      CloseHandle(candidate);
      return fail(env, "AssignProcessToJobObject", error);
    }
    job = candidate;
  }
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_value value;
  napi_create_function(env, "join", NAPI_AUTO_LENGTH, join, NULL, &value);
  napi_set_named_property(env, exports, "join", value);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
