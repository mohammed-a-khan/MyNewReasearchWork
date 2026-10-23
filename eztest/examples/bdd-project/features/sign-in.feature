# No step definitions needed: every step is an EZTest phrasing.
@smoke @auth
Feature: Signing in
  Staff sign in to the EZ Shop with their username and password.

  Scenario: Sign in with the form
    Given I am on "/login"
    When I fill in the form:
      | field    | value     |
      | Username | bob       |
      | Password | Builder#2 |
    And I click the "Sign in" button
    Then I should be on "/dashboard"
    And the page contains "Welcome, bob"

  Scenario: Sign in through the Identity Vault
    Given I am logged in as "manager"
    When I am on "/dashboard"
    Then the "Recent orders" table is visible

  Scenario: A wrong password is refused
    Given I am on "/login"
    When I type "bob" into the "Username" field
    And I type "not-the-password" into the "Password" field
    And I click the "Sign in" button
    Then the page contains "Invalid username or password"
