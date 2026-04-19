const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'nexus_dev_secret_change_in_prod';

const authenticate = (req, res, next) => {
  let token;
  const authHeader = req.headers.authorization;
  
  // 1. Try Authorization Header
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  } 
  
  // 2. Try Query Parameter (req.query)
  if (!token && req.query && req.query.token) {
    token = req.query.token;
  }

  // 3. Manual URL Parsing (Fallback if express query parser fails)
  if (!token) {
    const fullUrl = req.originalUrl || req.url || '';
    if (fullUrl.includes('token=')) {
      const parts = fullUrl.split('token=');
      if (parts.length > 1) {
        token = parts[1].split('&')[0];
        console.log(`[AUTH] Manual extraction successful: ${token.substring(0, 10)}...`);
      }
    }
  }

  if (!token || token === 'null' || token === 'undefined' || token === '') {
    console.log(`[AUTH] DENIED: No token found. URL: ${req.originalUrl || req.url}`);
    console.log(`[AUTH] Headers: ${JSON.stringify(req.headers)}`);
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

const isStudent = (req, res, next) => {
  if (req.user && req.user.role === 'student') {
    next();
  } else {
    res.status(403).json({ error: 'Access forbidden. Students only.' });
  }
};

const authorizeRoles = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: `Access forbidden. Requires one of these roles: ${roles.join(', ')}` });
    }
    next();
  };
};

module.exports = { authenticate, isStudent, authorizeRoles };
