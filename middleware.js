export const config = {
  matcher: "/((?!favicon.ico).*)",
};

export default function middleware(req) {
  const auth = req.headers.get("authorization");
  const expected = "Basic " + btoa(":" + (process.env.DASHBOARD_PASSWORD || ""));

  if (!process.env.DASHBOARD_PASSWORD || auth !== expected) {
    return new Response("Autenticação necessária", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="Painel La Semijoias"' },
    });
  }
}
