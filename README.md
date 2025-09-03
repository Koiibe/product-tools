# Product Tools Render Server

A Node.js/Express server that handles Notion webhooks to automatically copy workflow pages to stories database with proper date translation.

## Features

- Receives webhooks from Notion buttons
- Copies all pages from Product Workflows database to Stories database
- Maintains relational distance between dates
- Translates dates so the last date aligns with the epic's "fulfill by" date
- Adds epic name as prefix to page titles
- Preserves all property information from template pages

## Setup

1. Clone this repository
2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file based on `env.example`:
   ```bash
   cp env.example .env
   ```

4. Get your Notion API key:
   - Go to https://www.notion.com/my-integrations
   - Create a new integration
   - Copy the "Internal Integration Token"

5. Update `.env` with your Notion API key

6. Make sure your Notion integration has access to:
   - Product Workflows database (ID: `263ce8f7317a804dad72cac4e8a5aa60`)
   - Stories database (ID: `1c1ce8f7317a80dfafc4d95c8cb67c3e`)

## Usage

### Development
```bash
npm run dev
```

### Production
```bash
npm start
```

### Docker Deployment
```bash
# Quick deployment with Docker Compose
./deploy.sh

# Or manually:
docker-compose up --build -d

# View logs
docker-compose logs -f

# Stop server
docker-compose down
```

### Manual Testing
```bash
# Test health endpoint
curl http://localhost:3000/health

# Test webhook endpoint (replace with actual epic ID)
curl -X POST http://localhost:3000/webhook/notion \
  -H "Content-Type: application/json" \
  -d '{"epicId": "your-epic-page-id"}'
```

## Webhook Configuration

Set up your Notion button to send a webhook to:
```
POST http://your-server-url:3000/webhook/notion
```

### Notion Button Setup

1. Create a button in your Epic page
2. Configure the button action to "Call API"
3. Set the URL to your server's webhook endpoint
4. Set HTTP method to POST
5. Configure the body to include the epic ID:

```json
{
  "epicId": "{{page.id}}"
}
```

You can also include additional context:
```json
{
  "epicId": "{{page.id}}",
  "epicName": "{{page.properties.Name.title}}",
  "triggeredBy": "{{user.id}}",
  "timestamp": "{{timestamp}}"
}
```

### Expected Payload Structure

The webhook expects either:
- `epicId`: The Notion page ID of the triggering epic
- `page.id`: Alternative way to pass the epic ID (used by default Notion button)

If neither is provided, the server will return a 400 error.

## API Endpoints

- `POST /webhook/notion` - Main webhook endpoint
- `GET /health` - Health check endpoint

## Database Structure

### Product Workflows Database
- Contains template pages with dates and properties
- Used as the source for copying

### Stories Database
- Target database where pages are copied
- Should have similar properties to Product Workflows
- Must include a relation property to link back to the epic

## Date Translation Logic

The server maintains the relative time differences between pages while ensuring the latest date aligns with the epic's "fulfill by" date:

1. Finds all dates in the workflow pages
2. Identifies the latest date
3. Calculates the offset needed to align this date with the epic's deadline
4. Applies this offset to all dates while preserving intervals

## Error Handling

The server includes comprehensive error handling:
- Validates webhook payloads
- Handles Notion API errors gracefully
- Continues processing other pages if one fails
- Logs detailed error information

## Dependencies

- `express` - Web server framework
- `@notionhq/client` - Notion API client
- `dotenv` - Environment variable management
- `body-parser` - Request body parsing
- `cors` - Cross-origin resource sharing
