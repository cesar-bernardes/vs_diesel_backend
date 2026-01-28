function normalizeCargo(cargo) {
  return String(cargo || '').toUpperCase();
}

function requireCargo(allowed) {
  const allowedSet = new Set((allowed || []).map(normalizeCargo));

  return (req, res, next) => {
    const cargo = normalizeCargo(req.user && req.user.cargo);
    if (allowedSet.has(cargo)) return next();
    return res.status(403).json({ error: '🚫 Acesso negado' });
  };
}

function denyCargo(denied) {
  const deniedSet = new Set((denied || []).map(normalizeCargo));

  return (req, res, next) => {
    const cargo = normalizeCargo(req.user && req.user.cargo);
    if (!deniedSet.has(cargo)) return next();
    return res.status(403).json({ error: '🚫 Acesso negado' });
  };
}

module.exports = { requireCargo, denyCargo };
