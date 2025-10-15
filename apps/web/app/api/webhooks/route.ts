import { verifyWebhook } from '@clerk/nextjs/webhooks'
import { NextRequest } from 'next/server'
import { prisma } from "db/client";
import { ClerkUser } from '../../types/clerk';

export async function POST(req: NextRequest) {
  try {
    const evt = await verifyWebhook(req)

    // Do something with payload
    // For this guide, log payload to console
    const eventType = evt.type
    const { id } = evt.data;
    console.log(`Received webhook with ID ${id} and event type of ${eventType}`)
    console.log('Webhook payload:', evt.data);

    
    if (evt.type === 'user.created') {
        const user : ClerkUser = evt.data;

        const email = user.email_addresses[0]?.email_address || "";
        const name = `${user.first_name || ' '} ${user.last_name || ' '}`.trim();
        const provider = user.external_accounts?.[0]?.provider || null;
        const providerUserId = user.external_accounts?.[0]?.provider_user_id || null;
            // Add user entry to DB
        console.log('userId:', evt.data.id);
        const newUser = await prisma.user.create({
            data : {
                clerkId : user.id,
                email,
                name,
                profileImageUrl : user.image_url,
                provider,
                providerUserId
            }
        })
        console.log(newUser);
    }

     if (evt.type === 'user.updated') {
        const user : ClerkUser = evt.data;

        const email = user.email_addresses[0]?.email_address || "";
        const name = `${user.first_name || ' '} ${user.last_name || ' '}`.trim();
        const provider = user.external_accounts?.[0]?.provider || null;
        const providerUserId = user.external_accounts?.[0]?.provider_user_id || null;
            // Add user entry to DB
        console.log('userId:', evt.data.id);
        const newUser = await prisma.user.update({
            where : {email},
            data : {
                clerkId : user.id,
                email,
                name,
                profileImageUrl : user.image_url,
                provider,
                providerUserId
            }
        })
        console.log(newUser);
    }
    return new Response('Webhook received', { status: 200 })
  } catch (err) {
    console.error('Error verifying webhook:', err)
    return new Response('Error verifying webhook', { status: 400 })
  }
}