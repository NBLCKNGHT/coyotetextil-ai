-- Create ENUM type for customer tiers
CREATE TYPE customer_tier AS ENUM ('VIP', 'Recurrente', 'Lead');

-- Create Customers table
CREATE TABLE customers (
    id SERIAL PRIMARY KEY,
    phone_id VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(255),
    tier customer_tier DEFAULT 'Lead',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create Campaigns table
CREATE TABLE campaigns (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    message_body TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create Raw Messages table
CREATE TABLE raw_messages (
    id SERIAL PRIMARY KEY,
    phone_id VARCHAR(50) NOT NULL,
    message_body TEXT NOT NULL,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    potential_sale BOOLEAN DEFAULT FALSE,
    FOREIGN KEY (phone_id) REFERENCES customers(phone_id)
);

-- Create Sales table
CREATE TABLE sales (
    id SERIAL PRIMARY KEY,
    phone_id VARCHAR(50) NOT NULL,
    amount DECIMAL(10, 2),
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (phone_id) REFERENCES customers(phone_id)
);
