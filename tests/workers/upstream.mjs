// Synthetic fault-injection transport to the suite's disposable HTTP stub.
export default {
  fetch(request) {
    const url = new URL(request.url);
    url.host = "127.0.0.1:8788";
    url.protocol = "http:";
    return fetch(new Request(url, request));
  },
};
