/**
 * A Postman collection for the demo API (test/fixtures/demo-api.ts), as a client's team would
 * write one: a folder of GET checks, two requests that change data (which must never be sent on
 * a live API), and a script that sends its own POST (removed before the run).
 */
export function demoCollection() {
  const test = (...lines: string[]) => [{ listen: "test", script: { type: "text/javascript", exec: lines } }];
  const get = (name: string, path: string, event?: unknown[]) => ({
    name,
    request: { method: "GET", header: [], url: { raw: `{{baseUrl}}${path}`, host: ["{{baseUrl}}"], path: path.slice(1).split("/") } },
    ...(event ? { event } : {}),
  });
  return {
    info: { name: "Demo Shop API checks", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
    variable: [{ key: "baseUrl", value: "https://shop.example.com/v1" }],
    item: [
      {
        name: "Catalogue",
        item: [
          get("Health is up", "/health", test(`pm.test("status is 200", () => pm.response.to.have.status(200));`)),
          get(
            "Product prices are numbers",
            "/products",
            test(
              `pm.test("status is 200", () => pm.response.to.have.status(200));`,
              `pm.test("price is a number", () => pm.expect(typeof pm.response.json()[0].price).to.eql("number"));`,
            ),
          ),
          get("Orders load", "/orders", test(`pm.test("status is 200", () => pm.response.to.have.status(200));`)),
        ],
      },
      get("Signed-in user", "/users/1", test(`pm.test("status is 200", () => pm.response.to.have.status(200));`)),
      {
        name: "Create a user",
        request: { method: "POST", header: [], body: { mode: "raw", raw: '{"name":"Test"}' }, url: { raw: "{{baseUrl}}/users", host: ["{{baseUrl}}"], path: ["users"] } },
      },
      { name: "Delete a user", request: { method: "DELETE", url: "{{baseUrl}}/users/1" } },
      {
        name: "Status with a side request",
        event: [
          {
            listen: "prerequest",
            script: { type: "text/javascript", exec: [`pm.sendRequest({ url: pm.variables.get("baseUrl") + "/users", method: "POST" }, () => {});`] },
          },
          ...test(`pm.test("status is 200", () => pm.response.to.have.status(200));`),
        ],
        request: { method: "GET", url: "{{baseUrl}}/status" },
      },
    ],
  };
}
