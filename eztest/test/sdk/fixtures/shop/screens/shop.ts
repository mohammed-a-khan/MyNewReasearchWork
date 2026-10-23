/** Screens of the EZ Shop demo app (synthetic fixture for the SDK tests). */
import { screen } from 'eztest/sdk';

export const Login = screen('Login', {
  username: { label: 'Username', testId: 'username' },
  password: { label: 'Password', testId: 'password' },
  signIn: { role: 'button', name: 'Sign in', css: '#login-btn' },
});

export const Dashboard = screen('Dashboard', {
  welcome: { testId: 'welcome-user', description: 'welcome user name' },
  orders: { role: 'table', name: 'Recent orders' },
  orderLink: (id: string) => ({ role: 'link', name: id, description: `order ${id}` }),
});

export const NewOrder = screen('New order', {
  customer: { label: 'Customer' },
  product: { label: 'Product' },
  quantity: { label: 'Quantity' },
  submit: { role: 'button', name: 'Submit order', css: '#submit-order' },
});

export const Order = screen('Order', {
  number: 'testid=order-number',
  customer: 'testid=order-customer',
  total: 'testid=order-total',
  invoice: { role: 'link', name: 'Download invoice' },
});
