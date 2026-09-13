export async function GET(
  _request: Request,
  _context: { params: Promise<{ id: string }> },
) {
  return Response.json({ error: "not implemented" }, { status: 501 });
}
