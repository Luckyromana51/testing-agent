function Post({ html }) {
  // ruleid: glv.js.react-raw-html
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
function Safe({ html }) {
  // ok: glv.js.react-raw-html
  return <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html) }} />;
}
