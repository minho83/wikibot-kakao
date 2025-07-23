# KakaoTalk Wiki Bot with n8n Integration

A KakaoTalk chatbot that integrates with the LOD Wiki search system via n8n workflows.

## Features

- **Command Processing**: Supports wiki search, Q&A, probability queries, and more
- **Rate Limiting**: Built-in cooldown and request limiting per user
- **n8n Integration**: Ready-to-use n8n workflow for KakaoTalk integration
- **Error Handling**: Comprehensive error handling and logging
- **Health Monitoring**: Built-in health check endpoints

## Supported Commands

- `!검색 [검색어]` - Hybrid search execution
- `!질문 [질문내용]` - AI-based Q&A
- `!확률 [뽑기명]` - Nexon Now probability information
- `!통계` - Database statistics
- `!연결테스트` - Server connection test
- `!캐시클리어` - Clear AI response cache
- `!도움말` - Display help message

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd wikibot
```

2. Install dependencies:
```bash
npm install
```

3. Configure environment variables:
```bash
cp .env.example .env
# Edit .env with your configuration
```

4. Start the server:
```bash
npm start
# or for development
npm run dev
```

## Configuration

### Environment Variables

- `PORT` - Server port (default: 3000)
- `NODE_ENV` - Environment (development/production)
- `WIKI_API_BASE_URL` - Wiki API base URL
- `WIKI_API_TIMEOUT` - API timeout in milliseconds
- `COOLDOWN_SECONDS` - Cooldown between requests (default: 5)
- `MAX_REQUESTS_PER_USER` - Max requests per user per hour (default: 100)

### n8n Workflow Setup

1. Import the workflow from `n8n/workflows/kakao-chatbot-workflow.json`
2. Configure the webhook URL in your KakaoTalk channel
3. Update the Wiki API Call node URL to match your server
4. Activate the workflow

## API Endpoints

### Webhook Endpoint
```
POST /webhook/kakao
```

Request format:
```json
{
  "message": "!검색 퀘스트",
  "user_id": "user123",
  "room_id": "room456"
}
```

Response format:
```json
{
  "success": true,
  "message": "검색 결과...",
  "response_type": "text"
}
```

### Health Check
```
GET /health
```

## Architecture

```
KakaoTalk → n8n Webhook → Message Parser → Wiki API → Response Formatter → KakaoTalk
```

## Rate Limiting

- 5-second cooldown between commands per user (configurable)
- Maximum 100 requests per user per hour (configurable)
- Automatic cleanup of rate limit data

## Error Handling

- Comprehensive error logging
- User-friendly error messages
- Development vs production error details
- Automatic retry logic for API calls

## Development

```bash
# Start in development mode
npm run dev

# Run tests
npm test
```

## Production Deployment

1. Set `NODE_ENV=production`
2. Configure production environment variables
3. Use process manager like PM2:
```bash
pm2 start src/index.js --name wikibot
```

## Integration with Existing Wiki System

This bot is designed to work with the existing LOD Wiki system at:
- Base URL: `http://192.168.0.3:8000`
- Uses existing `/api/messenger/*` endpoints
- Maintains compatibility with current rate limiting and caching

## License

MIT