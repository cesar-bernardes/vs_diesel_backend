const jwt = require('jsonwebtoken');
require('dotenv').config();

// Usaremos a mesma chave do Supabase para assinar nossos tokens, ou crie uma JWT_SECRET no .env
const SECRET = process.env.SUPABASE_KEY; 

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ error: '🚫 Token não fornecido' });
  }

  const token = authHeader.split(' ')[1];

  try {
    // Verifica se o token foi assinado por nós
    const decoded = jwt.verify(token, SECRET);
    
    // Anexa o usuário decodificado na requisição
    req.user = decoded;
    
    next();
  } catch (err) {
    return res.status(403).json({ error: '🚫 Token inválido ou expirado' });
  }
}

module.exports = authMiddleware;