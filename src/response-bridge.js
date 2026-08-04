const MESSAGE_SOURCE = "NyaModifyHeader";

function publish(rules) {
  window.postMessage({
    source: MESSAGE_SOURCE,
    type: "SET_RESPONSE_RULES",
    rules: Array.isArray(rules) ? rules : []
  }, "*");
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "UPDATE_RESPONSE_RULES") {
    publish(message.rules);
  }
});

chrome.runtime.sendMessage({ type: "GET_RESPONSE_RULES" })
  .then((response) => {
    if (response?.ok) {
      publish(response.rules);
    }
  })
  .catch(() => undefined);
