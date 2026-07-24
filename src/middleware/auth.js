function requireAdmin(req, res, next) {
  if (req.session?.adminId) return next();
  return res.redirect('/admin/login');
}

function guestOnly(req, res, next) {
  if (req.session?.adminId) return res.redirect('/admin');
  return next();
}

module.exports = { requireAdmin, guestOnly };
