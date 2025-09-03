#!/bin/bash

# Simple deployment script for the Product Tools Render Server

echo "🚀 Starting deployment of Product Tools Render Server..."

# Check if .env file exists
if [ ! -f .env ]; then
    echo "❌ Error: .env file not found!"
    echo "Please create a .env file based on env.example"
    exit 1
fi

# Check if Docker is available
if ! command -v docker &> /dev/null; then
    echo "❌ Error: Docker is not installed or not in PATH"
    exit 1
fi

# Stop existing containers
echo "🛑 Stopping existing containers..."
docker-compose down

# Build and start containers
echo "🔨 Building and starting containers..."
docker-compose up --build -d

# Wait for health check
echo "⏳ Waiting for server to be healthy..."
sleep 10

# Check health
if curl -f http://localhost:3000/health &> /dev/null; then
    echo "✅ Server is running and healthy!"
    echo "🌐 Server URL: http://localhost:3000"
    echo "📚 Health check: http://localhost:3000/health"
    echo "🎣 Webhook endpoint: http://localhost:3000/webhook/notion"
else
    echo "❌ Server failed to start properly"
    echo "Check logs with: docker-compose logs"
    exit 1
fi

echo "🎉 Deployment completed successfully!"
