const errorHandler = (err, req, res, next) => {
  console.error('Error occurred:', {
    message: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
    body: req.body,
    timestamp: new Date().toISOString()
  });

  if (res.headersSent) {
    return next(err);
  }

  const isDevelopment = process.env.NODE_ENV === 'development';
  
  res.status(err.status || 500).json({
    success: false,
    message: err.message || '서버 내부 오류가 발생했습니다.',
    error: isDevelopment ? {
      message: err.message,
      stack: err.stack
    } : undefined,
    timestamp: new Date().toISOString()
  });
};

module.exports = errorHandler;