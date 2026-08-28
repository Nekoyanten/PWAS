export function requireAdmin(req, res, next) {
  const key = req.header("x-api-key");
  if (!key || key !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: "No autorizado. Falta o es inválida la cabecera x-api-key." });
  }
  return next();
}
