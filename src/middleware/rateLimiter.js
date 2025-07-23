const rateLimitMap = new Map();

const rateLimiter = (req, res, next) => {
  const { user_id } = req.body;
  const cooldownSeconds = parseInt(process.env.COOLDOWN_SECONDS) || 5;
  const maxRequests = parseInt(process.env.MAX_REQUESTS_PER_USER) || 100;
  
  if (!user_id) {
    return res.status(400).json({
      success: false,
      error: 'user_id is required'
    });
  }

  const now = Date.now();
  const userKey = `user_${user_id}`;
  const hourKey = `hour_${user_id}_${Math.floor(now / (1000 * 60 * 60))}`;
  
  const lastRequest = rateLimitMap.get(userKey);
  const hourlyRequests = rateLimitMap.get(hourKey) || 0;

  if (lastRequest && (now - lastRequest) < (cooldownSeconds * 1000)) {
    const remainingTime = Math.ceil((cooldownSeconds * 1000 - (now - lastRequest)) / 1000);
    return res.json({
      success: false,
      message: `⏰ ${remainingTime}초 후에 다시 시도해주세요.`,
      cooldown: remainingTime
    });
  }

  if (hourlyRequests >= maxRequests) {
    return res.json({
      success: false,
      message: '⚠️ 시간당 요청 제한을 초과했습니다. 잠시 후 다시 시도해주세요.',
      rate_limited: true
    });
  }

  rateLimitMap.set(userKey, now);
  rateLimitMap.set(hourKey, hourlyRequests + 1);

  setTimeout(() => {
    rateLimitMap.delete(userKey);
  }, cooldownSeconds * 1000);

  setTimeout(() => {
    rateLimitMap.delete(hourKey);
  }, 60 * 60 * 1000);

  next();
};

module.exports = rateLimiter;