FROM node:20.11-alpine3.18

WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Copy the rest of the application
COPY . .

# Install Node.js dependencies
RUN npm install

# Install NestJS CLI globally
RUN npm install -g @nestjs/cli

# Set the command to run the application
CMD ["npm", "run", "start:dev"]
